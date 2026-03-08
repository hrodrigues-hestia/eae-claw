# auto-pull.ps1 - Watches the repo and auto-pulls when changes are detected
# Run in a separate PowerShell window: .\auto-pull.ps1
# Only pulls frontend changes - Vite hot reload handles the rest without closing the app

$interval = 15  # seconds between checks
$repoDir = $PSScriptRoot  # assumes script is in the repo root

Write-Host ""
Write-Host "  🦀 Eae Claw Auto-Pull" -ForegroundColor Cyan
Write-Host "  Watching for changes every ${interval}s..." -ForegroundColor Gray
Write-Host "  Vite hot reload will update the app automatically." -ForegroundColor Gray
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

Set-Location $repoDir

while ($true) {
    try {
        # Fetch latest from remote (quiet)
        git fetch origin main 2>&1 | Out-Null
        
        # Compare local and remote
        $local = git rev-parse HEAD 2>&1
        $remote = git rev-parse origin/main 2>&1
        
        if ($local -ne $remote) {
            $timestamp = Get-Date -Format "HH:mm:ss"
            
            # Check what changed
            $changedFiles = git diff --name-only HEAD origin/main 2>&1
            $hasRustChanges = $changedFiles | Where-Object { $_ -match "src-tauri/" -and $_ -match "\.(rs|toml)$" }
            
            Write-Host "[$timestamp] 🔄 Mudanças detectadas!" -ForegroundColor Yellow
            
            # Stash local changes if any
            $status = git status --porcelain 2>&1
            $hadLocalChanges = $false
            if ($status) {
                git stash 2>&1 | Out-Null
                $hadLocalChanges = $true
                Write-Host "[$timestamp]    Stashed local changes" -ForegroundColor Gray
            }
            
            # Pull
            $pullOutput = git pull origin main 2>&1
            Write-Host "[$timestamp] ✅ Atualizado!" -ForegroundColor Green
            
            # Show changed files
            foreach ($file in $changedFiles) {
                Write-Host "[$timestamp]    📄 $file" -ForegroundColor Gray
            }
            
            # Restore local changes
            if ($hadLocalChanges) {
                git stash pop 2>&1 | Out-Null
                Write-Host "[$timestamp]    Restored local changes" -ForegroundColor Gray
            }
            
            if ($hasRustChanges) {
                Write-Host "[$timestamp] ⚠️  Rust files changed - restart 'npx tauri dev' when ready" -ForegroundColor Yellow
            } else {
                Write-Host "[$timestamp] 🔥 Frontend only - Vite hot reload should apply automatically" -ForegroundColor Green
            }
            
            Write-Host ""
        }
    }
    catch {
        $timestamp = Get-Date -Format "HH:mm:ss"
        Write-Host "[$timestamp] ⚠️ Erro: $_" -ForegroundColor Red
    }
    
    Start-Sleep -Seconds $interval
}
