# 댓글 에이전트 크롬 창을 맨 앞(항상 위)으로 올리거나 되돌립니다.
#   -Token 문자열 : 창 제목에 이 문자열이 있는 창을 찾음
#   -Hwnd  번호   : 이미 찾은 창 번호
#   -Top 1 / 0    : 항상 위 켜기 / 끄기
param([string]$Token = '', [string]$Hwnd = '', [int]$Top = 1)
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class UmwWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static IntPtr Find(string token) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      if (sb.ToString().Contains(token)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$h = [IntPtr]::Zero
if ($Hwnd) { $h = [IntPtr][long]$Hwnd }
else { for ($i = 0; $i -lt 40 -and $h -eq [IntPtr]::Zero; $i++) { $h = [UmwWin]::Find($Token); if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 } } }
if ($h -eq [IntPtr]::Zero) { 'NOTFOUND'; exit 1 }
$flags = 0x0001 -bor 0x0002 -bor 0x0040   # 크기·위치 유지 + 보이기
if ($Top -eq 1) {
  if ([UmwWin]::IsIconic($h)) { [UmwWin]::ShowWindow($h, 9) | Out-Null }
  [UmwWin]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, $flags) | Out-Null   # 항상 위
  [UmwWin]::SetForegroundWindow($h) | Out-Null
} else {
  [UmwWin]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, $flags) | Out-Null   # 항상 위 해제
}
"OK $([long]$h)"
