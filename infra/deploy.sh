#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
stack="${HUNAR_STACK:-hunar-prototype}"
export AWS_PAGER=''
export AWS_EC2_METADATA_DISABLED=true
AWS=(aws --region "$region")
account="$("${AWS[@]}" sts get-caller-identity --query Account --output text)"
bucket="hunar-build-${account}-${region}"
domain="${HUNAR_AUTH_DOMAIN:-hunar-${account}-${region}}"
mkdir -p .deploy
artifact="$(pwd)/.deploy/lambda.zip"
rm -f "$artifact"
zip -q "$artifact" server/{aws,api,data,voice,bedrock}.mjs public/pack.json
key="builds/$(shasum -a 256 "$artifact" | awk '{print $1}').zip"

if ! "${AWS[@]}" s3api head-bucket --bucket "$bucket" --expected-bucket-owner "$account" 2>/dev/null; then
  if [[ "$region" == us-east-1 ]]; then
    "${AWS[@]}" s3api create-bucket --bucket "$bucket" >/dev/null
  else
    "${AWS[@]}" s3api create-bucket --bucket "$bucket" --create-bucket-configuration "LocationConstraint=$region" >/dev/null
  fi
fi
"${AWS[@]}" s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
"${AWS[@]}" s3 cp "$artifact" "s3://$bucket/$key" --only-show-errors
"${AWS[@]}" cloudformation deploy --stack-name "$stack" --template-file infra/template.yml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides \
  "ArtifactBucket=$bucket" "ArtifactKey=$key" "AuthDomain=$domain" \
  "ElevenLabsSecretArn=${ELEVENLABS_SECRET_ARN:-}" "ElevenLabsVoiceId=${ELEVENLABS_VOICE_ID:-}" "BedrockModelArn=${BEDROCK_MODEL_ARN:-}"

output() {
  "${AWS[@]}" cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}
web_bucket="$(output WebBucket)"
# Set JS module and manifest types explicitly so browsers allow module imports.
"${AWS[@]}" s3 sync public "s3://$web_bucket" --exclude '*.mjs' --exclude '*.webmanifest' --only-show-errors
for file in public/*.mjs; do
  "${AWS[@]}" s3 cp "$file" "s3://$web_bucket/${file##*/}" --content-type 'text/javascript; charset=utf-8' --only-show-errors
done
"${AWS[@]}" s3 cp public/app.webmanifest "s3://$web_bucket/app.webmanifest" --content-type application/manifest+json --only-show-errors
printf 'Hunar URL: %s\nCognito user pool: %s\n' "$(output WebUrl)" "$(output UserPoolId)"
