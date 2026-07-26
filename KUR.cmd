@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   INDIVA Trendyol Scraper - Kurulum
echo ============================================
echo.

REM 0) Yonetici yetkisi var mi? Windows Servisi kurmak icin sart.
REM NOT: "net session" bunun icin yaygin kullanilir ama Windows'un "Server"
REM (LanmanServer) servisi kapaliysa (birçok ev bilgisayarinda kapalidir)
REM yonetici olsan bile hata doner - yanlis pozitif verir. "fsutil dirty
REM query" ise hicbir servise bagli olmadan sadece yonetici yetkisini
REM kontrol eder - daha guvenilir.
fsutil dirty query %systemdrive% >nul 2>nul
if errorlevel 1 (
  echo [HATA] Bu dosyayi "Yonetici olarak calistir" ile baslatmaniz gerekiyor.
  echo        ^(KUR.cmd'ye sag tikla -^> "Yonetici olarak calistir"^)
  echo        Neden: scraper artik gercek bir Windows Servisi olarak kuruluyor
  echo        ^(Session 0'da calisir, Chrome kullaniciya HICBIR ZAMAN gorunmez^)
  echo        ve servis kurulumu yonetici yetkisi gerektirir.
  echo.
  pause
  exit /b 1
)

REM 1) Node.js var mi?
where node >nul 2>nul
if errorlevel 1 (
  echo [HATA] Node.js kurulu degil.
  echo        https://nodejs.org adresinden LTS surumunu kurun, sonra bu dosyayi tekrar calistirin.
  echo.
  pause
  exit /b 1
)

REM 2) service-account.json var mi?
if not exist "service-account.json" (
  echo [HATA] service-account.json bulunamadi.
  echo        Firebase servis hesabi dosyasini bu klasore "service-account.json" adiyla kopyalayin.
  echo.
  pause
  exit /b 1
)

REM 3) Chrome var mi? (uyari, engellemez)
if not exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" if not exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  echo [UYARI] Google Chrome bulunamadi. Scraping icin Chrome gerekli.
  echo         https://www.google.com/chrome adresinden kurun.
  echo.
)

echo [1/3] Bagimliliklar kuruluyor (npm install)... biraz surebilir.
call npm install
if errorlevel 1 (
  echo [HATA] npm install basarisiz.
  pause
  exit /b 1
)

echo.
echo [2/2] Windows Servisi kuruluyor ve baslatiliyor...
echo       (Session 0'da calisir - Chrome PC ekraninda ASLA gorunmez,
echo        oturum acik olmasi bile gerekmez.)
call node service-install.js
if errorlevel 1 (
  echo [HATA] Servis kurulumu basarisiz oldu. Yukaridaki hataya bakin.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   TAMAMLANDI
echo   "IndivaScraperService" servisi calisiyor ve
echo   PC her acildiginda otomatik baslayacak - oturum
echo   acmasaniz bile. Artik telefondan "Veri Cek" ile
echo   tetikleyebilirsiniz. Durumu gormek icin:
echo   services.msc -^> IndivaScraperService
echo ============================================
echo.
pause
