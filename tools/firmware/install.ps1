$ErrorActionPreference = 'Stop'
try {
    $Host.UI.RawUI.WindowTitle = 'KV9RU - OpenWrt'
    Write-Host 'KV9RU | Original firmware + settings + FRPC' -ForegroundColor Cyan
    Write-Host 'The firmware image is unchanged. The router will reboot and its network settings may change.'
    foreach ($command in @('ssh', 'scp')) { if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw 'Install Windows OpenSSH Client first.' } }
    Set-Location -LiteralPath $PSScriptRoot
    foreach ($line in Get-Content -LiteralPath 'SHA256SUMS') {
        if ($line -notmatch '^([0-9a-f]{64})  (firmware.bin|settings.tar.gz|check.sh)$') { throw 'Invalid checksum manifest.' }
        if ((Get-FileHash -LiteralPath $Matches[2] -Algorithm SHA256).Hash -ne $Matches[1]) { throw 'A package file is damaged. Download it again.' }
    }
    $gateway = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
    $suggested = if ($gateway) { $gateway.IPv4DefaultGateway.NextHop } else { '192.168.1.1' }
    $router = Read-Host "Router IPv4 address [$suggested]"
    if (-not $router) { $router = $suggested }
    $address = $null
    if (-not [Net.IPAddress]::TryParse($router, [ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Enter an IPv4 address.' }
    $router = $address.ToString()
    $remoteDirectory = '/tmp/kv9-' + [Guid]::NewGuid().ToString('N')
    $options = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15')
    & ssh @options "root@$router" "umask 077; mkdir $remoteDirectory"
    if ($LASTEXITCODE -ne 0) { throw 'SSH connection failed.' }
    & scp -O @options firmware.bin settings.tar.gz SHA256SUMS check.sh "root@${router}:$remoteDirectory/"
    if ($LASTEXITCODE -ne 0) { throw 'Upload failed. Firmware was not changed.' }
    & ssh @options "root@$router" "cd $remoteDirectory && sh check.sh && sysupgrade -b before-upgrade.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw 'Router compatibility check or configuration backup failed. Upgrade cancelled.' }
    $backup = 'router-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.tar.gz'
    & scp -O @options "root@${router}:$remoteDirectory/before-upgrade.tar.gz" $backup
    if ($LASTEXITCODE -ne 0) { throw 'Cannot save the backup to this PC. Upgrade cancelled.' }
    Write-Host "Checks passed. Old configuration saved: $backup" -ForegroundColor Green
    Write-Host 'Use a wired connection and stable power. Have someone at the router for recovery.' -ForegroundColor Yellow
    if ((Read-Host 'Type UPDATE to flash the ORIGINAL image with the supplied settings') -cne 'UPDATE') { Write-Host 'Cancelled. Firmware was not changed.'; exit 0 }
    & ssh @options "root@$router" "cd $remoteDirectory && sh check.sh && sysupgrade -f settings.tar.gz firmware.bin"
    if ($LASTEXITCODE -notin @(0,255)) { throw 'Upgrade command reported an error. Inspect the output above.' }
    Write-Host 'SSH has returned or disconnected. This does NOT confirm a successful boot.' -ForegroundColor Yellow
    Write-Host 'Wait for the router, then use the LAN address from README.txt. FRPC appears after Internet access is available.'
} catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
} finally {
    Read-Host 'Press Enter to close'
}
