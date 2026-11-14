#!/usr/bin/env bash
# Creates a private, encrypted S3 bucket and an IAM policy for Campus Hub.
# Usage: ./infra/setup-aws.sh my-college-campus-hub ap-south-1
# Requires the AWS CLI configured with permissions to create buckets and IAM policies.
set -euo pipefail

BUCKET="${1:?usage: $0 <bucket-name> [region]}"
REGION="${2:-ap-south-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "Creating bucket $BUCKET in $REGION..."
if [ "$REGION" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
fi

# Nothing in the bucket is ever public: files are served through short-lived presigned URLs.
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled

# Move old noncurrent versions to cheaper storage / expire them to control cost.
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{
  "Rules":[{"ID":"expire-old-versions","Status":"Enabled","Filter":{"Prefix":""},
  "NoncurrentVersionExpiration":{"NoncurrentDays":30},
  "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":7}}]}'

POLICY_FILE="$(mktemp)"
sed "s/YOUR-BUCKET-NAME/$BUCKET/" "$HERE/s3-iam-policy.json" > "$POLICY_FILE"
ARN=$(aws iam create-policy --policy-name "CampusHubS3-$BUCKET" --policy-document "file://$POLICY_FILE" \
  --query Policy.Arn --output text)
rm -f "$POLICY_FILE"

cat <<EOF

Done.
  1. Create an IAM role for EC2 (trusted entity: EC2) and attach this policy:
       $ARN
  2. Attach the role to your EC2 instance.
  3. Set in your .env:
       S3_BUCKET=$BUCKET
       AWS_REGION=$REGION
EOF
