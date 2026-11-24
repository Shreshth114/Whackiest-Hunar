import { createHmac, createHash } from 'node:crypto';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { makeApi } from './api.mjs';
import { accounts } from './data.mjs';

const table = process.env.STATE_TABLE;
const bucket = process.env.EVIDENCE_BUCKET;
const region = process.env.AWS_REGION;
const dynamo = new DynamoDBClient();
const s3 = new S3Client();
const recordKey = { id: { S: 'workspace-v1' } };

async function snapshot(initial) {
  const { Item } = await dynamo.send(new GetItemCommand({ TableName: table, Key: recordKey, ConsistentRead: true }));
  return Item ? { state: JSON.parse(Item.payload.S), revision: Number(Item.revision.N) } : { state: initial(), revision: 0 };
}

const db = {
  async read(initial) { return (await snapshot(initial)).state; },
  async change(initial, fn) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { state, revision } = await snapshot(initial);
      const result = fn(state);
      const payload = JSON.stringify(state);
      if (Buffer.byteLength(payload) > 350000) throw Object.assign(new Error('The demo workspace has reached its record limit.'), {status:507});
      try {
        await dynamo.send(new PutItemCommand({
          TableName: table,
          Item: { ...recordKey, revision: { N: String(revision + 1) }, payload: { S: payload } },
          ConditionExpression: revision ? 'revision = :old' : 'attribute_not_exists(id)',
          ...(revision ? { ExpressionAttributeValues: { ':old': { N: String(revision) } } } : {})
        }));
        return result;
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
      }
    }
    throw Object.assign(new Error('This workspace changed. Please retry.'), {status:409});
  }
};

const encode = input => encodeURIComponent(input).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
const sha = input => createHash('sha256').update(input).digest('hex');
const hmac = (key, input) => createHmac('sha256', key).update(input).digest();
const host = bucket + '.s3.' + region + '.amazonaws.com';
async function signer() {
  const credentials = await s3.config.credentials();
  const time = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = time.slice(0, 8);
  const scope = day + '/' + region + '/s3/aws4_request';
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + credentials.secretAccessKey, day), region), 's3'), 'aws4_request');
  return { credentials, time, scope, sign: input => hmac(signingKey, input).toString('hex') };
}

const media = {
  async prepare(item) {
    const { credentials, time, scope, sign } = await signer();
    const fields = {
      key: item.key, 'Content-Type': item.type, 'x-amz-algorithm': 'AWS4-HMAC-SHA256',
      'x-amz-credential': credentials.accessKeyId + '/' + scope, 'x-amz-date': time
    };
    if (credentials.sessionToken) fields['x-amz-security-token'] = credentials.sessionToken;
    const policy = Buffer.from(JSON.stringify({
      expiration: new Date(Date.now() + 600000).toISOString(),
      conditions: [{ bucket }, ...Object.entries(fields).map(([key,value]) => ({ [key]: value })),
        ['content-length-range', item.size, item.size]]
    })).toString('base64');
    fields.policy = policy;
    fields['x-amz-signature'] = sign(policy);
    return { mode: 'post', url: 'https://' + host + '/', fields };
  },
  async inspect(item) {
    try {
      const value = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: item.key }));
      return { size: value.ContentLength, type: value.ContentType, version: value.VersionId };
    } catch (error) { if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) return null; throw error; }
  },
  async play(item) {
    if (!item.mediaVersion) throw Object.assign(new Error('The stored video version is unavailable.'), {status:409});
    const { credentials, time, scope, sign } = await signer();
    const params = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': credentials.accessKeyId + '/' + scope,
      'X-Amz-Date': time, 'X-Amz-Expires': '300', 'X-Amz-SignedHeaders': 'host', versionId: item.mediaVersion,
      'response-cache-control': 'private, no-store'
    };
    if (credentials.sessionToken) params['X-Amz-Security-Token'] = credentials.sessionToken;
    const query = Object.keys(params).sort().map(key => encode(key) + '=' + encode(params[key])).join('&');
    const path = '/' + item.key.split('/').map(encode).join('/');
    const canonical = ['GET',path,query,'host:' + host + '\n','host','UNSIGNED-PAYLOAD'].join('\n');
    const signature = sign(['AWS4-HMAC-SHA256',time,scope,sha(canonical)].join('\n'));
    return { status:200, headers:{'Content-Type':'application/json','Cache-Control':'no-store'},
      body:JSON.stringify({url:'https://' + host + path + '?' + query + '&X-Amz-Signature=' + signature}) };
  }
};

const config = {
  clientId: process.env.COGNITO_CLIENT_ID,
  authUrl: process.env.COGNITO_URL,
  reviewer: process.env.REVIEWER_USERNAME || 'reviewer',
  demoListings: true
};
const extract = process.env.BEDROCK_MODEL_ARN ? async transcript => {
  const { extractJobFilters } = await import('./bedrock.mjs');
  return extractJobFilters(transcript);
} : null;
const api = makeApi({ db, media, config, extract });

function actorFor(claims) {
  if (!claims || claims.token_use !== 'id') return null;
  const uid = claims['cognito:username'];
  const roles = String(claims['cognito:groups'] || '').match(/\b(worker|reviewer|employer|teacher)\b/g);
  if (!uid || !/^[a-z0-9-]{1,80}$/i.test(uid) || roles?.length !== 1) return null;
  const role = roles[0];
  return { id: uid, role, name: claims.name || (Object.hasOwn(accounts,uid) ? accounts[uid].name : uid) };
}

export async function handler(event) {
  const path = event.rawPath + (event.rawQueryString ? '?' + event.rawQueryString : '');
  const result = await api({
    path, method:event.requestContext.http.method, headers:event.headers || {},
    actor:actorFor(event.requestContext.authorizer?.jwt?.claims),
    body:Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8')
  });
  return {
    statusCode:result.status, headers:result.headers, body:Buffer.isBuffer(result.body) ? result.body.toString('base64') : result.body,
    isBase64Encoded:Buffer.isBuffer(result.body)
  };
}
