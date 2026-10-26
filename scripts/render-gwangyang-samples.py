from pathlib import Path
import json
import win32com.client

import sys
root=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else Path(__file__).resolve().parents[1]/'output'/'gwangyang'
print('Starting dedicated Hancom COM instance',flush=True)
app=win32com.client.DispatchEx('HWPFrame.HwpObject')
print('COM instance ready',flush=True)
pattern=sys.argv[2] if len(sys.argv)>2 else '*.hwpx'
result_path=root/'hancom-export.json'
results=json.loads(result_path.read_text(encoding='utf8')) if len(sys.argv)>2 and result_path.exists() else []
try:
    registered=app.RegisterModule('FilePathCheckDLL','FilePathCheckerModuleExample')
    app.XHwpWindows.Item(0).Visible=False
    app.SetMessageBoxMode(0x2FFF1)
    print('Security module: '+str(registered),flush=True)
    for p in sorted(root.glob(pattern)):
        print('Opening '+p.name,flush=True)
        opened=app.Open(str(p),'HWPX','forceopen:true')
        if not opened:raise RuntimeError(f'Open failed: {p.name}')
        target=p.with_suffix('.pdf')
        saved=app.SaveAs(str(target),'PDF','')
        if not saved or not target.exists():raise RuntimeError(f'PDF save failed: {p.name}')
        results=[r for r in results if r['file']!=p.name]
        results.append({'file':p.name,'pdf':target.name,'pages':app.PageCount,'security_module':bool(registered),'renderer':'Hancom COM'})
        print(json.dumps(results[-1],ensure_ascii=False),flush=True)
        app.Clear(1)
finally:
    app.Quit()
(root/'hancom-export.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')


