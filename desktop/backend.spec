from pathlib import Path

root = Path(SPECPATH).parent
a = Analysis(
    [str(root / 'desktop' / 'backend.py')],
    pathex=[str(root)],
    datas=[(str(root / 'config' / 'settings.yaml'), 'config')],
    hiddenimports=['frontend.proxy_server', 'uvicorn.logging', 'uvicorn.loops.auto',
                   'uvicorn.protocols.http.auto', 'uvicorn.lifespan.on', 'gradio_client'],
    excludes=['tkinter', 'pytest'],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='pdf2skill-backend',
          console=True, strip=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name='pdf2skill-backend', strip=False, upx=False)
