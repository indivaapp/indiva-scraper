# Belirtilen process ID'ye ait, o an ekranda olan pencereyi görev çubuğundan
# tamamen gizler (WS_EX_TOOLWINDOW stiline çevirir). scrape.js tarafından,
# Chrome başlatıldıktan hemen sonra çağrılır (bkz. hideFromTaskbar).
# Bu bir "best effort" adımdır — başarısız olursa scrape.js'i durdurmaz,
# Chrome yine de minimize kalır (bkz. minimizeWindow, CDP tabanlı).
param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class IndivaTaskbarHider {
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    const int GWL_EXSTYLE = -20;
    const int WS_EX_APPWINDOW = 0x40000;
    const int WS_EX_TOOLWINDOW = 0x80;
    // NOT: Daha önce burada ShowWindow(HIDE) + ShowWindow(SHOWNOACTIVATE) ile
    // gizle/göster tetikleniyordu — bu, Windows Gezgini'nin görev çubuğu
    // düğmesi önbelleğini pencerenin gerçek durumundan bağımsız bırakabiliyor
    // ("hayalet" düğüm: süreç kapansa bile kullanıcı tıklayana kadar görev
    // çubuğunda kalıyor — canlı şikayette "bazen kapanmıyor, tıklayınca
    // kapanıyor" olarak bildirildi). Doğru/standart Win32 kalıbı, stil
    // değişikliğini SetWindowPos + SWP_FRAMECHANGED ile bildirmek —
    // pencerenin görünürlük/aktiflik durumuna HİÇ dokunmadan görev çubuğunun
    // yeniden çizilmesini (ve WS_EX_TOOLWINDOW'un etkin olmasını) sağlar.
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_FRAMECHANGED = 0x0020;

    public static int Hide(uint targetPid) {
        int count = 0;
        EnumWindows((hWnd, lParam) => {
            uint procId;
            GetWindowThreadProcessId(hWnd, out procId);
            if (procId == targetPid && IsWindowVisible(hWnd)) {
                int style = GetWindowLong(hWnd, GWL_EXSTYLE);
                style = (style & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
                SetWindowLong(hWnd, GWL_EXSTYLE, style);
                SetWindowPos(hWnd, IntPtr.Zero, 0, 0, 0, 0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
                count++;
            }
            return true;
        }, IntPtr.Zero);
        return count;
    }
}
"@

$hidden = [IndivaTaskbarHider]::Hide([uint32]$ProcessId)
Write-Output "hidden=$hidden"
