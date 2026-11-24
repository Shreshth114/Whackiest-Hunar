# Hunar prototype

Hunar brings together school practice with weak connectivity, practical skill review, and local job discovery. This repository is the runnable hackathon build. The separate architecture document describes the broader design.

## Run the demo on your computer

Requires Node.js 22 or later. The local demo has no npm dependency installation.

```sh
npm run dev
```

Open <http://127.0.0.1:4173/>. The server listens on loopback and keeps its demo data in `.data/`. You can select Worker, Reviewer, Employer, or Teacher in the header. These are fictional demo accounts. Use the AWS deployment for authenticated access across devices.

To rehearse from a fresh set of listings and accounts, run `npm run demo` and open <http://127.0.0.1:4175/>. Each run has its own temporary server data. Use a fresh private browser window or clear each learner's device progress before rehearsing the school flow again. Stopping the rehearsal server removes its temporary data.

### Walk through the three flows

1. **Prove a skill.** In Worker mode, open **Prove**, read the rubric, consent to review, and upload a short MP4/WebM/MOV or select **Use sample clip**. The sample is a simple training illustration. A draft left by an interruption can be continued with the original file or discarded. Switch to Reviewer, open evidence, and record a finding plus a supporting note per criterion. Approve to issue a peer-reviewed task credential, or request another attempt. The worker can submit a follow-up directly from that review. Open Passport to make an optional share link. The reviewer can revoke the credential and the worker can disable the share link.
2. **Find work nearby.** In Worker mode, open **Nearby**. Search by locality and trade, select whether to share a passport credential, and apply to a clearly labeled demo job. In Employer mode, publish or close a listing, and shortlist or decline a demo application. **My applications** shows the outcome to the worker even after a posting closes.
3. **Learn offline.** In Teacher mode, download **Everyday numeracy** and wait for **Ready offline**. Try English and Hindi or switch between the two anonymous learner aliases. On a fresh Learner A, answer **12** and then **9** to reach the next difficulty. To demonstrate a cold offline open, take the browser offline and reload the school page. Reconnect and open **Class progress** after syncing. Unacknowledged answers stay on that browser. **Clear this learner on this device** removes that learner's device history and unsent answers while preserving synced class counts.

### Hackathon rehearsal

Use a real clip of a safely supervised training task if one is available. Label the included illustration as a fixture. Rehearse voice search with “plumbing jobs near Rampur” and keep the manual locality and trade controls visible for corrections. In the school flow, verify a page reload with browser networking disabled, then verify that the teacher sees each answer once after reconnecting. Keep a short recording of that rehearsal for unreliable demo connectivity.

## Enable ElevenLabs

Use an ElevenLabs key with permission for speech-to-text, and text-to-speech if you also want read-aloud. Put the key in your own shell environment or create a private `.env.local` from `.env.example`. Keep the key out of chat and source control.

```sh
chmod 600 .env.local
npm run dev
```

When configured, **Search by voice** in Nearby uses the microphone and sends the short recording to the server-side ElevenLabs integration. The transcript and proposed filters are editable before search. The browser needs microphone permission. If `ELEVENLABS_VOICE_ID` is set, each listing also offers **Read listing aloud**. Text controls are always available. This code uses server-side provider calls and local test doubles in automated tests. A real provider call requires usable account credentials and quota.

## Deploy to AWS

The CloudFormation template creates a CloudFront PWA, a private web bucket, an authenticated API Gateway/Lambda backend, a versioned private evidence bucket, DynamoDB storage, and a Cognito user pool. Public share URLs expose only the selected passport fields. Create this stack in a sandbox or hackathon account with deployment permissions.

1. Authenticate the AWS CLI for your intended account and verify `aws sts get-caller-identity`. Set `AWS_PROFILE` and `AWS_REGION` if needed.
2. For live voice, put the ElevenLabs key in AWS Secrets Manager using the AWS console or your usual secret workflow. Use a secret string containing the key or JSON with the field `ELEVENLABS_API_KEY`. Set `ELEVENLABS_SECRET_ARN` to the secret ARN and optionally set `ELEVENLABS_VOICE_ID`. With a customer-managed KMS key, the Lambda role also needs appropriate key permissions.
3. Optionally set `BEDROCK_MODEL_ARN` to a permitted on-demand model in your deployment region that supports Converse. Model extraction can suggest a missing trade or locality. Predictions are constrained to the configured options and require user confirmation. The deterministic parser handles known phrases and model failures.

```sh
npm run deploy:aws
bash infra/create-demo-users.sh
```

The deployment prints the CloudFront URL. The account script prompts privately for a temporary password for each of the four initial Cognito users. Use `worker`, `reviewer`, `employer`, and `teacher`. Cognito requests a new password on first sign-in. Use a separate browser profile or sign out between roles. A new submission is assigned to the `reviewer` account. The AWS app displays authenticated roles, and local role switching is available in the loopback demo.

Evidence uploads go from the browser to S3 using a size-restricted signed form. Authorized evidence playback uses the exact submitted object version and expires after five minutes. The evidence bucket and DynamoDB table are retained on stack deletion. See the CloudFormation outputs before cleaning up resources.

### Deployment smoke check

Open the CloudFront URL. Walk through the same four roles, use a disposable training clip, and confirm that school practice reloads offline. In Nearby, record a short request such as “plumbing near Rampur,” check the transcript and filters, then search. Check the listing read-aloud control if configured. Confirm that a signed-out browser can open a worker-approved link and that disabling it takes effect.

## Run verification

```sh
npm test
npm run test:http
```

The first command verifies domain flows and the voice client contract with test doubles. The second starts an isolated loopback server and checks assets, actual sample video upload, reviewer permissions, credential sharing, local job application, and duplicate-safe teacher sync.

## Prototype boundaries

The AWS build stores the small demo workspace as one versioned DynamoDB item, with conditional writes and a size cap. The architecture plan's separate tables and indexes are a scale-up step. Voice uses bounded push-to-talk requests and a text fallback. A background queue, resumable uploads, external identity checks, and reviewer accreditation are scale-up work. This build uses one vocational task, one school unit, and a configurable-area matching model illustrated by three demo localities. School content should be reviewed by an educator before use with real students. Local student profiles use anonymous aliases in the browser and a teacher-owned online progress view.
