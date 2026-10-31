# 특정 크롬 프로필(user-data-dir) 창을 맨 앞으로 띄웁니다. 잠깐 '항상 위'로 올렸다가 풀어서 대시보드 앞에 보이게 합니다.
param([string]$Dir = '')
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class UmwFront {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public static List<IntPtr> ByPids(HashSet<uint> pids) {
    var r = new List<IntPtr>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h)) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); if (sb.Length > 0) r.Add(h); }
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@
$flags = 0x0001 -bor 0x0002 -bor 0x0040
for ($i = 0; $i -lt 30; $i++) {
  $pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($Dir.ToLower()) -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { [void]$pids.Add([uint32]$_.ProcessId) }
  $wins = if ($pids.Count) { [UmwFront]::ByPids($pids) } else { @() }
  if ($wins.Count -gt 0) {
    $h = $wins[0]
    [UmwFront]::ShowWindow($h, 9) | Out-Null
    [UmwFront]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, $flags) | Out-Null
    [UmwFront]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 1200
    [UmwFront]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, $flags) | Out-Null
    [UmwFront]::SetForegroundWindow($h) | Out-Null
    "OK $([long]$h)"; exit 0
  }
  Start-Sleep -Milliseconds 300
}
'NOTFOUND'; exit 1
