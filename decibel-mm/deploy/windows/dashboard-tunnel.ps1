# Opens the Decibel MM dashboard at http://localhost:8787 on this Windows PC through an SSH tunnel to the VM, and keeps
# the tunnel up: when it drops (sleep, Wi-Fi change, VM reboot) it is opened again after 3 seconds, by itself.
#
# Why this instead of Cloud Shell: the address never changes (the page remembers its token and settings), and nothing here
# expires after a few minutes of inactivity.
#
# Needs: Google Cloud CLI (gcloud, already logged in: `gcloud auth login`) and the Windows OpenSSH client (built in to
# Windows 10/11; Settings > Apps > Optional features). Close this window to stop.
#
# Usage:  powershell -ExecutionPolicy Bypass -File dashboard-tunnel.ps1
param(
  [string]$Vm = "decibel-mm",
  [string]$Zone = "asia-southeast1-b",
  [int]$LocalPort = 8787,
  [switch]$NoBrowser
)

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  Write-Host "Chua cai Google Cloud CLI (gcloud). Cai tai https://cloud.google.com/sdk/docs/install roi chay lai." -ForegroundColor Red
  exit 1
}
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  Write-Host "Chua co OpenSSH client. Bat trong Settings > Apps > Optional features > OpenSSH Client." -ForegroundColor Red
  exit 1
}

if (-not $NoBrowser) {
  # Open the browser once the page answers (the first connection takes a few seconds).
  Start-Job -ScriptBlock {
    param($p)
    for ($i = 0; $i -lt 90; $i++) {
      try {
        Invoke-WebRequest -UseBasicParsing "http://localhost:$p/healthz" -TimeoutSec 3 | Out-Null
        Start-Process "http://localhost:$p"
        break
      } catch { Start-Sleep -Seconds 2 }
    }
  } -ArgumentList $LocalPort | Out-Null
}

$n = 0
while ($true) {
  $n++
  Write-Host ("[{0}] Mo duong ham lan {1}: http://localhost:{2}" -f (Get-Date -Format "HH:mm:ss"), $n, $LocalPort)
  & gcloud compute ssh $Vm --zone $Zone `
    --ssh-flag="-N" `
    --ssh-flag="-L" --ssh-flag="${LocalPort}:localhost:8787" `
    --ssh-flag="-o ServerAliveInterval=20" --ssh-flag="-o ServerAliveCountMax=3" `
    --ssh-flag="-o ExitOnForwardFailure=yes" --ssh-flag="-o StrictHostKeyChecking=accept-new"
  Write-Host ("Duong ham da dong (ma {0}). Thu lai sau 3 giay. Dong cua so nay de dung." -f $LASTEXITCODE) -ForegroundColor Yellow
  Start-Sleep -Seconds 3
}
