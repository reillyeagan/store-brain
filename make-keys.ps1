# Store Brain - make the 2 private keys and add them to Cloudflare.
# Runs only on this PC. The keys are shown on screen once, for you to save.
# They are never written to a file that stays on disk, and Claude never sees them.

function New-RandomKey([int]$len) {
  $chars = 'abcdefghijkmnpqrstuvwxyz23456789'.ToCharArray()
  $bytes = New-Object byte[] $len
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

$mcKey   = New-RandomKey 40
$signKey = New-RandomKey 48

$tmp = Join-Path $env:TEMP ('sb-' + [guid]::NewGuid().ToString() + '.json')
try {
  $json = '{"MC_KEY":"' + $mcKey + '","APPROVAL_SIGNING_KEY":"' + $signKey + '"}'
  [System.IO.File]::WriteAllText($tmp, $json)
  Write-Host ''
  Write-Host '  Adding the keys to Cloudflare...'
  & npx --yes wrangler@4 secret bulk $tmp
  $ok = ($LASTEXITCODE -eq 0)
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
}

Write-Host ''
if (-not $ok) {
  Write-Host '  Something went wrong adding the keys. Nothing to save - just run this file again.' -ForegroundColor Red
  exit 1
}
Write-Host '  ==========================================================' -ForegroundColor Green
Write-Host '   DONE. SAVE THIS IN YOUR PASSWORD MANAGER NOW:' -ForegroundColor Green
Write-Host '  ==========================================================' -ForegroundColor Green
Write-Host ''
Write-Host '   Mission Control key (MC_KEY):'
Write-Host ('     ' + $mcKey) -ForegroundColor Yellow
Write-Host ''
Write-Host '   (The approval signing key was also added. You never need it.)'
Write-Host '   Do not send these to Claude or paste them into any chat.'
Write-Host ''
