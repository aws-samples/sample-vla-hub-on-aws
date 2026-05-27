import pathlib

# N1.6: Eagle2 backbone — flash_attention_2 패치 적용
p = pathlib.Path('/opt/gr00t/gr00t/model/modules/eagle_backbone.py')
if not p.exists():
    print("patch SKIP: eagle_backbone.py not found")
else:
    src = p.read_text()

    old_eager = 'self.model = AutoModel.from_config(config, trust_remote_code=True, attn_implementation="eager")'
    old_none  = 'self.model = AutoModel.from_config(config, trust_remote_code=True)'
    new = 'self.model = AutoModel.from_config(config, trust_remote_code=True, attn_implementation="flash_attention_2")'

    if new in src:
        print("patch SKIP: eagle_backbone.py already has flash_attention_2")
    elif old_eager in src:
        p.write_text(src.replace(old_eager, new))
        print("patch OK: eagle_backbone.py (eager -> flash_attention_2)")
    elif old_none in src:
        p.write_text(src.replace(old_none, new))
        print("patch OK: eagle_backbone.py (added flash_attention_2)")
    else:
        print("patch WARN: known patterns not found — eagle_backbone.py unchanged")
