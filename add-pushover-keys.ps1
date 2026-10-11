# Store Brain - add the two Pushover keys to Cloudflare.
# You type (paste) them here; they are hidden as you paste, sent straight to Cloudflare,
# and the temporary file is deleted. Claude never sees them.

function Read-Hidden([string]$prompt) {
  $sec = Read-Host -Prompt $prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

Write-Host ''
Write-Host '  Paste each key and press Enter. Nothing will show while you paste - that is normal.'
Write-Host ''
$user  = Read-Hidden '  1) Your User Key (top right of pushover.net after you log in)'
$token = Read-Hidden '  2) The Store Brain app API Token (pushover.net > Your Applications > Store Brain)'

# Pushover keys are exactly 30 letters/numbers. Catch a bad paste before it goes anywhere.
foreach ($pair in @(@('User Key', $user), @('API Token', $token))) {
  if ($pair[1] -notmatch '^[A-Za-z0-9]{30}$') {
    Write-Host ''
    Write-Host ('  That ' + $pair[0] + " doesn't look right (it should be 30 letters and numbers). Nothing was saved - run this file again.") -ForegroundColor Red
    exit 1
  }
}
if ($user -eq $token) {
  Write-Host ''
  Write-Host '  Those two are the same key - the User Key and the API Token are different. Nothing was saved.' -ForegroundColor Red
  exit 1
}

$tmp = Join-Path $env:TEMP ('sb-' + [guid]::NewGuid().ToString() + '.json')
try {
  [System.IO.File]::WriteAllText($tmp, '{"PUSHOVER_USER_KEY":"' + $user + '","PUSHOVER_APP_TOKEN":"' + $token + '"}')
  Write-Host ''
  Write-Host '  Adding them to Cloudflare...'
  & npx --yes wrangler@4 secret bulk $tmp
  $ok = ($LASTEXITCODE -eq 0)
} finally { if (Test-Path $tmp) { Remove-Item $tmp -Force } }

Write-Host ''
if ($ok) {
  Write-Host '  Done. Both Pushover keys are in Cloudflare. Nothing to save.' -ForegroundColor Green
  Write-Host '  Next: Mission Control > Setup > Send test notification.'
} else {
  Write-Host '  Something went wrong adding the keys. Nothing was saved - run this file again.' -ForegroundColor Red
}
