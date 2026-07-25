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
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    const int GWL_EXSTYLE = -20;
    const int WS_EX_APPWINDOW = 0x40000;
    const int WS_EX_TOOLWINDOW = 0x80;
    const int SW_HIDE = 0;
    const int SW_SHOWNOACTIVATE = 4;

    public static int Hide(uint targetPid) {
        int count = 0;
        EnumWindows((hWnd, lParam) => {
            uint procId;
            GetWindowThreadProcessId(hWnd, out procId);
            if (procId == targetPid && IsWindowVisible(hWnd)) {
                int style = GetWindowLong(hWnd, GWL_EXSTYLE);
                style = (style & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
                SetWindowLong(hWnd, GWL_EXSTYLE, style);
                // Stil değişikliğinin görev çubuğuna yansıması için gizle-göster tetiklenir.
                ShowWindow(hWnd, SW_HIDE);
                ShowWindow(hWnd, SW_SHOWNOACTIVATE);
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
