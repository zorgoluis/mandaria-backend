# Operator-run helper. Creates one empty DigitalOcean tag; never attaches resources.
# Required scopes: tag:read and tag:create. No token is written to disk.
$ErrorActionPreference = 'Stop'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$restoreTag = 'mandaria-restore-test'
$restoreSecret = Read-Host 'Token temporal de DigitalOcean (entrada oculta)' -AsSecureString
$restorePointer = [IntPtr]::Zero
$restoreHeaders = $null
$restoreToken = $null
try {
    $restorePointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($restoreSecret)
    $restoreToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($restorePointer)
    if ([string]::IsNullOrWhiteSpace($restoreToken)) { throw 'Empty token' }
    $restoreHeaders = @{ Authorization = 'Bearer ' + $restoreToken }
    $restoreUri = 'https://api.digitalocean.com/v2/tags/' + $restoreTag
    try {
        $restoreResult = Invoke-RestMethod -Uri $restoreUri -Headers $restoreHeaders -Method Get -TimeoutSec 30 -MaximumRedirection 0
    } catch {
        if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 404) { throw }
        $restoreBody = @{ name = $restoreTag } | ConvertTo-Json -Compress
        $null = Invoke-RestMethod -Uri 'https://api.digitalocean.com/v2/tags' -Headers $restoreHeaders -Method Post -ContentType 'application/json' -Body $restoreBody -TimeoutSec 30 -MaximumRedirection 0
        $restoreResult = Invoke-RestMethod -Uri $restoreUri -Headers $restoreHeaders -Method Get -TimeoutSec 30 -MaximumRedirection 0
    }
    if ($restoreResult.tag.name -cne $restoreTag) { throw 'Unexpected tag' }
    Write-Output 'OK: etiqueta mandaria-restore-test disponible. Este script no asigna recursos ni modifica firewalls.'
    Write-Output 'Revoca el token temporal en DigitalOcean. Comprueba que la etiqueta no tenga recursos antes de asociarla al firewall.'
} catch {
    # Never print exception bodies, requests, headers or the token.
    $restoreStatus = 'sin codigo HTTP'
    if ($null -ne $_.Exception.Response) { $restoreStatus = 'HTTP ' + [int]$_.Exception.Response.StatusCode }
    Write-Output ('No se pudo confirmar la etiqueta (' + $restoreStatus + '). No crear el clon. Revisar permisos o conexion; no compartir el token.')
    exit 1
} finally {
    if ($null -ne $restoreHeaders) { $restoreHeaders.Clear() }
    $restoreToken = $null
    if ($restorePointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($restorePointer) }
    $restoreSecret.Dispose()
}
