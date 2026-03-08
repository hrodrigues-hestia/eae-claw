# auto-pull.ps1 - Watches the repo and auto-pulls when changes are detected
# Run in a separate PowerShell window: .\auto-pull.ps1

$interval = 15  # seconds between checks
$repoDir = $PSScriptRoot  # assumes script is in the repo root

Write-Host "🦀 Eae Claw Auto-Pull" -ForegroundColor Cyan
Write-Host "Watching for changes every ${interval}s..." -ForegroundColor Gray
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

Set-Location $repoDir

while ($true) {
    try {
        # Fetch latest from remote
        $fetchOutput = git fetch origin main 2>&1
        
        # Compare local and remote
        $local = git rev-parse HEAD 2>&1
        $remote = git rev-parse origin/main 2>&1
        
        if ($local -ne $remote) {
            $timestamp = Get-Date -Format "HH:mm:ss"
            Write-Host "[$timestamp] 🔄 Mudanças detectadas! Fazendo pull..." -ForegroundColor Yellow
            
            $pullOutput = git pull origin main 2>&1
            Write-Host "[$timestamp] ✅ Atualizado!" -ForegroundColor Green
            Write-Host $pullOutput -ForegroundColor Gray
            Write-Host ""
        }
    }
    catch {
        $timestamp = Get-Date -Format "HH:mm:ss"
        Write-Host "[$timestamp] ⚠️ Erro: $_" -ForegroundColor Red
    }
    
    Start-Sleep -Seconds $interval
}
