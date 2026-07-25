# Dinleyiciyi Windows oturum açılışında TAMAMEN GÖRÜNMEZ şekilde başlatır
# (hiçbir pencere/görev çubuğu ikonu OLMADAN).
#
# YÖNTEM: Windows Görev Zamanlayıcı (Task Scheduler) — "Oturum açılışında"
# tetikleyicili, gizli bir görev; görev doğrudan node.exe'yi DEĞİL,
# start-hidden.ps1'i çalıştırır (o da Node'u -WindowStyle Hidden ile başlatır).
#
# NEDEN BU YÖNTEM (denenip elenen alternatifler için):
#   1) Başlangıç klasörü + VBS (windowStyle 0, Node'u DOĞRUDAN çağırıyor):
#      Node "Assertion failed: process_title, file src\win\util.c, line 412"
#      hatasıyla ÇÖKÜYOR (libuv'nin konsolsuz çalışma sorunu).
#   2) Başlangıç klasörü + VBS -> gizli PowerShell -> .NET CreateNoWindow ile
#      Node: çökmüyor ama SESSİZCE DONUYOR (Node hiç başlamıyor, hata da yok).
#   3) Görev Zamanlayıcı, node.exe'yi DOĞRUDAN çalıştırınca: oturum açılışının
#      en erken anında pencere görünmüyordu ama bu şansa dayalıydı — görev
#      elle "Çalıştır" ile tetiklenince (masaüstü zaten açıkken) pencere
#      normal şekilde görünür çıktı. Meğer Görev Zamanlayıcı'daki "Hidden"
#      ayarı SADECE görevin kendi listedeki görünürlüğünü etkiliyormuş,
#      başlattığı programın penceresini DEĞİL.
#   4) (GÜNCEL) Görev Zamanlayıcı -> start-hidden.ps1 -> Start-Process
#      -WindowStyle Hidden ile Node: Task Scheduler zaten oturum açılışında
#      gerçek bir interaktif oturumda çalıştığından (headless SYSTEM
#      bağlamından farklı), Start-Process'in -WindowStyle Hidden isteği
#      güvenilir şekilde uygulanıyor — hem otomatik başlangıçta hem elle
#      "Çalıştır" ile tetiklenince pencere hiç görünmüyor.
#
# Görev "Hidden" (gizli) ve "AtLogOn" (oturum açılışında) olarak kurulur.
# Eski Başlangıç klasörü VBS yöntemi kullanılmıyorsa (bu script'in önceki
# sürümlerinde oluşturulmuş olabilir) elle silinmesi önerilir — bu script
# artık onu OLUŞTURMUYOR.

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$wrapperScript = Join-Path $dir "start-hidden.ps1"
$psExe = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
if (-not $psExe) { $psExe = "powershell.exe" }

$taskName = "IndivaScraperListener"

# Varsa eskisini kaldır (yeniden kurulum/güncelleme senaryosu)
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute $psExe `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapperScript`"" `
    -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
# RestartCount/RestartInterval: listener.js çökerse (start-listener.cmd'nin
# eski "10 sn sonra yeniden başlat" döngüsüne benzer şekilde) Görev
# Zamanlayıcı'nın kendi native restart-on-failure özelliği devreye girer.
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Force | Out-Null

Write-Host "Otomatik baslatma kuruldu (Gorev Zamanlayici):" -ForegroundColor Green
Write-Host "  Gorev adi: $taskName"
Write-Host "  Calistirilacak: $psExe -> $wrapperScript -> node.exe listener.js (gizli pencere)"
Write-Host "  Klasor: $dir"
Write-Host ""
Write-Host "Simdi test etmek icin: Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor Yellow

# Eski (varsa) Başlangıç klasörü VBS'ini temizle — artık kullanılmıyor.
$startup = [Environment]::GetFolderPath('Startup')
$oldVbs = Join-Path $startup "indiva-scraper-runner.vbs"
if (Test-Path $oldVbs) {
    Remove-Item $oldVbs -Force
    Write-Host "Eski Baslangic klasoru VBS'i temizlendi." -ForegroundColor Green
}
