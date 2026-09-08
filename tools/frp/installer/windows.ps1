$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@PAYLOAD@@')) | ConvertFrom-Json
$temp = Join-Path ([IO.Path]::GetTempPath()) ('kv9-frpc-' + [Guid]::NewGuid().ToString('N'))
$code = 1
function Stage($number, $text) { Write-Host ''; Write-Host ('  [' + $number + '/5] ') -NoNewline -ForegroundColor Cyan; Write-Host $text -ForegroundColor White }
function Api($operation) {
    $body = @{ operation = $operation; fingerprint = $fingerprint } | ConvertTo-Json -Compress
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        try { return Invoke-RestMethod -Method Post -Uri $config.endpoint -Headers @{ Authorization = 'Bearer ' + $config.token } -ContentType 'application/json' -Body $body -TimeoutSec 25 }
        catch {
            if ($attempt -lt 2) { Start-Sleep -Seconds 2; continue }
            $message = $_.Exception.Message
            try { $message = ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch {}
            throw $message
        }
    }
}
try {
    $Host.UI.RawUI.WindowTitle = 'KV9 | Подключение OpenWrt'
    $Host.UI.RawUI.BackgroundColor = 'Black'
    Clear-Host
    # Classic console font only; Windows Terminal controls its own font.
    if (!$env:WT_SESSION) {
        try {
            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class KV9Font { [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Font { public uint cbSize; public uint nFont; public short X; public short Y; public int Family; public int Weight; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Face; } [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n); [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern bool SetCurrentConsoleFontEx(IntPtr h,bool max,ref Font f); public static void Apply(){ Font f=new Font(); f.cbSize=(uint)Marshal.SizeOf(f); f.Y=14; f.Family=54; f.Weight=400; f.Face="Consolas"; SetCurrentConsoleFontEx(GetStdHandle(-11),false,ref f); } }'
            [KV9Font]::Apply()
        } catch {}
    }
    Write-Host '  ============================================================' -ForegroundColor DarkCyan
    Write-Host '       KV9   /   OPENWRT' -ForegroundColor Cyan
    Write-Host ('       ' + $config.name) -ForegroundColor White
    Write-Host '  ============================================================' -ForegroundColor DarkCyan
    New-Item -ItemType Directory -Path $temp | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -LiteralPath $temp -AclObject $acl
    Stage 1 'Определяем роутер'
    $ip = $null
    try {
        $physical = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -ExpandProperty ifIndex)
        $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Where-Object { $_.NextHop -ne '0.0.0.0' -and $_.InterfaceIndex -in $physical } | Sort-Object @{Expression={ $_.RouteMetric + (Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $_.InterfaceIndex).InterfaceMetric }})
        if ($routes.Count) { $ip = $routes[0].NextHop }
    } catch {}
    if (!$ip) {
        try { $ip = (Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' | Where-Object DefaultIPGateway | Sort-Object IPConnectionMetric | Select-Object -First 1).DefaultIPGateway | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1 } catch {}
    }
    if ($ip) {
        Write-Host ('  Шлюз: ' + $ip) -ForegroundColor Green
    } else { $ip = (Read-Host '  IP роутера (не удалось определить шлюз)').Trim() }
    $parsed = $null
    if (![Net.IPAddress]::TryParse($ip, [ref]$parsed)) { throw 'Некорректный IP-адрес роутера.' }
    Stage 2 'Подключаемся по SSH'
    $plink = Join-Path $temp 'plink.exe'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://the.earth.li/~sgtatham/putty/0.85/w32/plink.exe' -OutFile $plink -TimeoutSec 120
    $signature = Get-AuthenticodeSignature -LiteralPath $plink
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Simon Tatham(?:,|$)') { throw 'Проверка подписи PuTTY не пройдена.' }
    $pinDir = Join-Path $env:LOCALAPPDATA 'KV9\RouterKeys'
    New-Item -ItemType Directory -Force -Path $pinDir | Out-Null
    $sha = [Security.Cryptography.SHA256]::Create()
    $pinId = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($config.token)))).Replace('-', '').ToLowerInvariant()
    $pinFile = Join-Path $pinDir ($pinId + '.txt')
    if (Test-Path -LiteralPath $pinFile) { $hostKey = [IO.File]::ReadAllText($pinFile).Trim() }
    else {
        $ErrorActionPreference = 'Continue'
        $probe = (& $plink -ssh -T -batch -v -noagent -l root $ip true 2>&1 | Out-String)
        $ErrorActionPreference = 'Stop'
        if ($probe -match 'POTENTIAL SECURITY BREACH|does not match the one') { throw 'SSH-ключ роутера изменился. Подключение остановлено.' }
        $match = [regex]::Match($probe, '(?m)^\s*((?:ssh-|ecdsa-)[^\r\n]*SHA256:[A-Za-z0-9+/=]+)\s*$')
        if (!$match.Success) {
            Write-Host '  Автоматический адрес не отвечает по SSH.' -ForegroundColor Yellow
            $ip = (Read-Host '  Укажите IP роутера вручную').Trim()
            $parsed = $null
            if (![Net.IPAddress]::TryParse($ip, [ref]$parsed)) { throw 'Некорректный IP-адрес.' }
            $ErrorActionPreference = 'Continue'
            $probe = (& $plink -ssh -T -batch -v -noagent -l root $ip true 2>&1 | Out-String)
            $ErrorActionPreference = 'Stop'
            if ($probe -match 'POTENTIAL SECURITY BREACH|does not match the one') { throw 'SSH-ключ роутера изменился. Подключение остановлено.' }
        $match = [regex]::Match($probe, '(?m)^\s*((?:ssh-|ecdsa-)[^\r\n]*SHA256:[A-Za-z0-9+/=]+)\s*$')
            if (!$match.Success) { throw 'Роутер не отвечает по SSH на порту 22.' }
        }
        $hostKey = $match.Groups[1].Value.Trim()
        Write-Host '  Первый SSH-ключ принят автоматически; изменения ключа будут отклонены.' -ForegroundColor DarkGray
    }
    $fingerprint = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($hostKey)))).Replace('-', '').ToLowerInvariant()
    $pwfile = Join-Path $temp 'password.txt'
    [IO.File]::WriteAllText($pwfile, $config.password, (New-Object Text.UTF8Encoding($false)))
    & $plink -ssh -T -batch -noagent -hostkey $hostKey -l root -pwfile $pwfile $ip 'test -f /etc/openwrt_release && test "$(id -u)" = 0'
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось войти в OpenWrt. Проверьте пароль, IP и SSH-ключ.' }
    [IO.File]::WriteAllText($pinFile, $hostKey)
    Stage 3 'Получаем свободный порт от сервера'
    $registration = Api 'claim'
    Write-Host ('  Выдан порт ' + $registration.port) -ForegroundColor Green
    Stage 4 'Устанавливаем и настраиваем FRPC'
    $command = Join-Path $temp 'router-command.txt'
    $remoteCommand = @"
umask 077
t=`$(mktemp /tmp/kv9-frpc.XXXXXX) || exit 1
trap 'rm -f "`$t"' EXIT
tr -d '\r' > "`$t"
sh "`$t" </dev/null
"@
    [IO.File]::WriteAllText($command, $remoteCommand.Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))
    $script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($registration.script))
    $script | & $plink -ssh -T -batch -noagent -hostkey $hostKey -l root -pwfile $pwfile -m $command $ip
    if ($LASTEXITCODE -ne 0) { throw 'Установка не завершена. Причина указана выше. Можно повторно запустить этот файл.' }
    Stage 5 'Проверяем появление устройства на сервере'
    $online = $false
    for ($i = 0; $i -lt 15; $i++) { if ((Api 'status').online) { $online = $true; break }; Start-Sleep -Seconds 2 }
    if (!$online) { throw 'FRPC установлен, но туннель пока не вышел в сеть. Проверьте интернет роутера и журнал FRPC в LuCI.' }
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host '       ГОТОВО — УСТРОЙСТВО ПОДКЛЮЧЕНО' -ForegroundColor Black -BackgroundColor Green
    Write-Host ('       ' + $registration.name) -ForegroundColor Green
    Write-Host ('       http://' + $registration.host + ':' + $registration.port + '/') -ForegroundColor Cyan
    Write-Host '  ============================================================' -ForegroundColor Green
    $code = 0
} catch {
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Red
    Write-Host '       ОШИБКА — УСТАНОВКА НЕ ЗАВЕРШЕНА' -ForegroundColor White -BackgroundColor DarkRed
    Write-Host ('  ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '  ============================================================' -ForegroundColor Red
} finally {
    $config.password = $null
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
Write-Host ''
Read-Host '  Нажмите Enter, чтобы закрыть окно' | Out-Null
exit $code
