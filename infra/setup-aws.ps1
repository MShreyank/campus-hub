<#
  Campus Hub - one-shot AWS S3 setup for Windows (PowerShell).

  Creates a PRIVATE, encrypted S3 bucket, a least-privilege IAM user, and writes the
  credentials + bucket into the project's .env so uploads go to the cloud.

  Prerequisites:
    1. Install AWS CLI v2:   winget install Amazon.AWSCLI
    2. Run `aws configure` once with an admin-capable access key (your own AWS account).

  Usage (from the project root):
    powershell -ExecutionPolicy Bypass -File infra\setup-aws.ps1 -Bucket my-college-campus-hub-demo -Region ap-south-1
#>
param(
  [Parameter(Mandatory = $true)][string]$Bucket,
  [string]$Region = "ap-south-1",
  [string]$IamUser = "campus-hub-app"
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Tmp = Join-Path $env:TEMP ("campushub-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Tmp | Out-Null

function Aws { & aws @args; if ($LASTEXITCODE -ne 0) { throw "aws $($args -join ' ') failed (exit $LASTEXITCODE)" } }
function FileUri($p) { "file://" + ((Resolve-Path $p).Path -replace '\\', '/') }

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw "AWS CLI not found. Install it with: winget install Amazon.AWSCLI  (then reopen PowerShell and run: aws configure)" }

Write-Host "Checking AWS credentials..." -ForegroundColor Cyan
Aws sts get-caller-identity --output table

# ---- Bucket -----------------------------------------------------------------
Write-Host "Creating bucket $Bucket in $Region..." -ForegroundColor Cyan
$exists = $true
& aws s3api head-bucket --bucket $Bucket 2>$null
if ($LASTEXITCODE -ne 0) { $exists = $false }
if (-not $exists) {
  if ($Region -eq "us-east-1") { Aws s3api create-bucket --bucket $Bucket --region $Region }
  else { Aws s3api create-bucket --bucket $Bucket --region $Region --create-bucket-configuration "LocationConstraint=$Region" }
} else { Write-Host "Bucket already exists - reusing it." }

# Nothing is public: the API streams files to the browser.
Aws s3api put-public-access-block --bucket $Bucket --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

$enc = Join-Path $Tmp "enc.json"
'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' | Set-Content -Path $enc -Encoding ascii
Aws s3api put-bucket-encryption --bucket $Bucket --server-side-encryption-configuration (FileUri $enc)

# ---- Least-privilege IAM user ----------------------------------------------------
Write-Host "Creating IAM user $IamUser..." -ForegroundColor Cyan
$policy = (Get-Content (Join-Path $PSScriptRoot "s3-iam-policy.json") -Raw) -replace 'YOUR-BUCKET-NAME', $Bucket
$policyFile = Join-Path $Tmp "policy.json"
$policy | Set-Content -Path $policyFile -Encoding ascii

& aws iam get-user --user-name $IamUser 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Aws iam create-user --user-name $IamUser | Out-Null }
Aws iam put-user-policy --user-name $IamUser --policy-name "CampusHubS3-$Bucket" --policy-document (FileUri $policyFile)

# Fresh access key (AWS allows 2 per user - remove old ones first if needed)
$keys = (& aws iam list-access-keys --user-name $IamUser --output json | ConvertFrom-Json).AccessKeyMetadata
foreach ($k in $keys) { Aws iam delete-access-key --user-name $IamUser --access-key-id $k.AccessKeyId }
$key = (Aws iam create-access-key --user-name $IamUser --output json | ConvertFrom-Json).AccessKey

# ---- Write .env ------------------------------------------------------------------
$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $Root ".env.example") $envFile }
$lines = [System.Collections.Generic.List[string]](Get-Content $envFile)
function Set-Env($name, $value) {
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*#?\s*$name=") { $lines[$i] = "$name=$value"; return }
  }
  $lines.Add("$name=$value")
}
Set-Env "S3_BUCKET" $Bucket
Set-Env "AWS_REGION" $Region
Set-Env "AWS_ACCESS_KEY_ID" $key.AccessKeyId
Set-Env "AWS_SECRET_ACCESS_KEY" $key.SecretAccessKey
$lines | Set-Content -Path $envFile -Encoding ascii

Remove-Item -Recurse -Force $Tmp
Write-Host ""
Write-Host "Done. Campus Hub will now store uploads in s3://$Bucket" -ForegroundColor Green
Write-Host "  .env updated: $envFile"
Write-Host "  Restart the server, then open http://localhost:4000/api/health - it should show storage: s3 and check.ok: true"
Write-Host "  (.env holds your IAM keys - it is git-ignored; don't share it.)"
