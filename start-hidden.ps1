# Görev Zamanlayıcı bunu çalıştırır. Node bir konsol uygulaması olduğu için
# doğrudan çağrılırsa (masaüstü zaten açıkken, ör. Görev Zamanlayıcı'dan elle
# "Çalıştır" ile tetiklenince) görünür bir pencere alır — Görev Zamanlayıcı'nın
# "Hidden" ayarı SADECE görevin kendi listedeki görünürlüğünü etkiler, başlattığı
# programın penceresini etkilemez. Bu yüzden Node'u burada, gerçek
# -WindowStyle Hidden isteğiyle Start-Process üzerinden başlatıyoruz.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = "node.exe" }

Start-Process -FilePath $nodeExe -ArgumentList "listener.js" -WorkingDirectory $dir -WindowStyle Hidden
