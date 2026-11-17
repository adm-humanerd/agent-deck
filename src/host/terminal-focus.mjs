// Only the Terminal tab hosting Herdr may be raised, never the Deck server tab.
export const terminalFocusScript = `tell application "Terminal"
set matches to {}
repeat with w in windows
repeat with t in tabs of w
set runningProcesses to processes of t
if runningProcesses contains "herdr" then
set end of matches to {w, t}
end if
end repeat
end repeat
if (count of matches) is not 1 then error "Herdr 터미널 탭을 하나로 특정할 수 없습니다. 터미널에서 Herdr 탭을 확인하세요."
set targetPair to item 1 of matches
set targetWindow to item 1 of targetPair
set selected tab of targetWindow to item 2 of targetPair
set miniaturized of targetWindow to false
set index of targetWindow to 1
activate
return "terminal-raised"
end tell`;
export async function raiseHerdrTerminal(exec){
 try{const result=await exec('/usr/bin/osascript',['-e',terminalFocusScript],{timeout:7000,maxBuffer:16384});if(result.stdout.trim()!=='terminal-raised')throw Error('unconfirmed');}
 catch{throw new Error('Herdr 탭은 선택했지만 PC 창을 앞으로 가져오지 못했습니다. macOS 터미널 제어 권한과 Herdr 탭을 확인하세요.');}
}
