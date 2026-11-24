#!/usr/bin/env bash
set -euo pipefail
region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
stack="${HUNAR_STACK:-hunar-prototype}"
export AWS_PAGER=''
AWS=(aws --region "$region")
pool="$("${AWS[@]}" cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue | [0]" --output text)"
for role in worker reviewer employer teacher; do
  if "${AWS[@]}" cognito-idp admin-get-user --user-pool-id "$pool" --username "$role" >/dev/null 2>&1; then
    printf '%s already exists; leaving its password untouched.\n' "$role"
    "${AWS[@]}" cognito-idp admin-add-user-to-group --user-pool-id "$pool" --username "$role" --group-name "$role"
    continue
  fi
  printf 'Enter a new temporary password for %s: ' "$role"
  IFS= read -rs password
  printf '\n'
  printf '%s' "$password" | ROLE="$role" POOL="$pool" node -e '
    (async () => {
      let password = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) password += chunk;
      process.stdout.write(JSON.stringify({
        UserPoolId:process.env.POOL, Username:process.env.ROLE,
        TemporaryPassword:password, MessageAction:"SUPPRESS"
      }));
    })();
  ' | "${AWS[@]}" cognito-idp admin-create-user --cli-input-json file:///dev/stdin >/dev/null
  unset password
  "${AWS[@]}" cognito-idp admin-add-user-to-group --user-pool-id "$pool" --username "$role" --group-name "$role"
done
