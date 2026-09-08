$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@PAYLOAD@@')) | ConvertFrom-Json
$temp = Join-Path ([IO.Path]::GetTempPath()) ('kv9-frpc-' + [Guid]::NewGuid().ToString('N'))
$code = 1
try {
    New-Item -ItemType Directory -Path $temp | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $temp -AclObject $acl
    $plink = Join-Path $temp 'plink.exe'
    Write-Host 'KV9 | OpenWrt FRPC installer' -ForegroundColor Cyan
    Write-Host 'Downloading the signed PuTTY SSH client...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://the.earth.li/~sgtatham/putty/0.85/w32/plink.exe' -OutFile $plink -TimeoutSec 120
    $signature = Get-AuthenticodeSignature -LiteralPath $plink
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Simon Tatham(?:,|$)') { throw 'PuTTY signature verification failed.' }
    $pwfile = Join-Path $temp 'password.txt'
    $command = Join-Path $temp 'router-command.txt'
    [IO.File]::WriteAllText($pwfile, $config.password, (New-Object Text.UTF8Encoding($false)))
    # The script travels as SSH stdin, not in the remote process command line.
    $remoteCommand = @'
umask 077
t=$(mktemp /tmp/kv9-frpc.XXXXXX) || exit 1
trap 'rm -f "$t"' EXIT
tr -d '\r' > "$t"
sh "$t" </dev/null
'@
    [IO.File]::WriteAllText($command, $remoteCommand.Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))
    Write-Host ('Connecting to root@' + $config.ip + ':' + $config.sshPort)
    Write-Host 'On first connection verify and accept the router SSH fingerprint.'
    & $plink -ssh -T -noagent -no-antispoof -P $config.sshPort -l root -pwfile $pwfile $config.ip 'true'
    if ($LASTEXITCODE -ne 0) { throw 'SSH connection failed. Check the IP, password and host key.' }
    $script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($config.script))
    $script | & $plink -ssh -T -batch -noagent -P $config.sshPort -l root -pwfile $pwfile -m $command $config.ip
    if ($LASTEXITCODE -ne 0) { throw 'Router installation failed. See the output above.' }
    Write-Host 'Installation complete. Check the device status in the KV9 panel.' -ForegroundColor Green
    $code = 0
} catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
} finally {
    $config.password = $null
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
exit $code
