$ErrorActionPreference = 'Stop'
$originalDirectory = Get-Location
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) ('kv9-installer-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDirectory > $null
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Destination $testDirectory
    foreach ($file in @('firmware.bin','settings.tar.gz','check.sh')) { [IO.File]::WriteAllText((Join-Path $testDirectory $file),'fixture') }
    $checks = foreach ($file in @('firmware.bin','settings.tar.gz','check.sh')) { (Get-FileHash (Join-Path $testDirectory $file)).Hash.ToLower() + '  ' + $file }
    $checks | Set-Content (Join-Path $testDirectory 'SHA256SUMS')
    function Get-NetIPConfiguration { [pscustomobject]@{IPv4DefaultGateway=[pscustomobject]@{NextHop='192.168.1.1'};NetAdapter=[pscustomobject]@{Status='Up'}} }
    function Read-Host { param($Prompt); if ($Prompt -like 'Type UPDATE*') { $global:kv9TestEvents.Add('confirm'); return 'UPDATE' }; return '' }
    function ssh { $global:kv9TestEvents.Add('ssh '+($args -join ' ')); $global:LASTEXITCODE=0; if ($global:kv9TestFailCheck -and ($args -join ' ') -like '*sysupgrade -b*') { $global:LASTEXITCODE=1 } }
    function scp { $global:kv9TestEvents.Add('scp '+($args -join ' ')); $global:LASTEXITCODE=0 }
    foreach ($failure in @($false,$true)) {
        $global:kv9TestFailCheck=$failure; $global:kv9TestEvents=[Collections.Generic.List[string]]::new()
        & (Join-Path $testDirectory 'install.ps1') | Out-Null
        $flashes=@($global:kv9TestEvents | Where-Object {$_ -like '*&& sysupgrade -f settings.tar.gz firmware.bin'})
        if ($failure) {
            if ($flashes.Count -or $global:kv9TestEvents.Contains('confirm')) {throw 'Compatibility failure did not stop the upgrade'}
        } else {
            if ($flashes.Count -ne 1) {throw 'Expected one explicitly confirmed upgrade'}
            $backupIndex=$global:kv9TestEvents.FindIndex([Predicate[string]]{param($event) $event -like 'scp *before-upgrade.tar.gz*'})
            if ($backupIndex -lt 0 -or $backupIndex -ge $global:kv9TestEvents.IndexOf('confirm')) {throw 'Backup must be saved before confirmation'}
            if ($global:kv9TestEvents.IndexOf($flashes[0]) -le $global:kv9TestEvents.IndexOf('confirm')) {throw 'Upgrade preceded confirmation'}
        }
    }
    [IO.File]::WriteAllText((Join-Path $testDirectory 'firmware.bin'),'tampered')
    $global:kv9TestEvents.Clear()
    & (Join-Path $testDirectory 'install.ps1') | Out-Null
    if ($global:kv9TestEvents.Count) {throw 'Tampered payload reached SSH'}
    Write-Output 'Installer tests passed: backup/confirmation ordering, failed preflight, tampered payload. All SSH/SCP calls mocked.'
    $global:LASTEXITCODE=0
} finally {
    Set-Location -LiteralPath $originalDirectory
    $resolved=(Resolve-Path -LiteralPath $testDirectory).Path
    if ([IO.Path]::GetFileName($resolved) -notlike 'kv9-installer-test-*' -or [IO.Path]::GetDirectoryName($resolved).TrimEnd('\','/') -ne [IO.Path]::GetTempPath().TrimEnd('\','/')) {throw 'Unexpected test cleanup path'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
