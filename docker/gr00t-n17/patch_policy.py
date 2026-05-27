import pathlib

# N1.7: eagle_backbone.py 없음 — Cosmos-Reason2-2B (qwen3_backbone.py) 백본으로 교체
# eagle_backbone.py flash_attention_2 패치 불필요 → no-op SKIP

p = pathlib.Path('/opt/gr00t/gr00t/model/modules/eagle_backbone.py')
if not p.exists():
    print("patch SKIP: eagle_backbone.py not found (N1.7 Cosmos-Reason2 backbone, no patch needed)")
else:
    src = p.read_text()

    # N1.6 패치 로직 (eagle_backbone.py가 존재하는 경우 fallback)
    old_eager = 'self.model = AutoModel.from_config(config, trust_remote_code=True, attn_implementation="eager")'
    old_none  = 'self.model = AutoModel.from_config(config, trust_remote_code=True)'
    new = 'self.model = AutoModel.from_config(config, trust_remote_code=True, attn_implementation="flash_attention_2")'

    if new in src:
        print("patch SKIP: eagle_backbone.py already has flash_attention_2")
    elif old_eager in src:
        p.write_text(src.replace(old_eager, new))
        print("patch OK: eagle_backbone.py (eager → flash_attention_2)")
    elif old_none in src:
        p.write_text(src.replace(old_none, new))
        print("patch OK: eagle_backbone.py (added flash_attention_2)")
    else:
        print("patch WARN: known patterns not found — eagle_backbone.py unchanged")

# N1.7 transformers 4.57.x workaround:
# Qwen3VLProcessor.from_pretrained(hf_repo_id) → _patch_mistral_regex() → model_info(hf_repo_id)
# → OfflineModeIsEnabled when HF_HUB_OFFLINE=1.
# Fix: patch build_processor() to resolve hf_repo_id → local snapshot path first.
proc_path = pathlib.Path('/opt/gr00t/gr00t/model/gr00t_n1d7/processing_gr00t_n1d7.py')
if proc_path.exists():
    src = proc_path.read_text()
    old_build = (
        "def build_processor(model_name: str, transformers_loading_kwargs: dict) -> Qwen3VLProcessor:\n"
        "    if Qwen3VLProcessor is None:\n"
        "        raise ImportError(\n"
        '            "Qwen3VLProcessor is not available. "\n'
        '            "Please upgrade transformers: pip install transformers>=4.52.0"\n'
        "        )\n"
        "    return Qwen3VLProcessor.from_pretrained(model_name, **transformers_loading_kwargs)"
    )
    new_build = (
        "def build_processor(model_name: str, transformers_loading_kwargs: dict) -> Qwen3VLProcessor:\n"
        "    if Qwen3VLProcessor is None:\n"
        "        raise ImportError(\n"
        '            "Qwen3VLProcessor is not available. "\n'
        '            "Please upgrade transformers: pip install transformers>=4.52.0"\n'
        "        )\n"
        "    # Resolve HF repo ID → local snapshot path so transformers treats it as local\n"
        "    # and skips _patch_mistral_regex() → model_info() → HF API call (offline error).\n"
        "    import pathlib as _pl\n"
        "    if not _pl.Path(model_name).exists():\n"
        "        try:\n"
        "            from huggingface_hub import snapshot_download\n"
        "            model_name = snapshot_download(model_name)\n"
        "        except Exception:\n"
        "            pass\n"
        "    return Qwen3VLProcessor.from_pretrained(model_name, **transformers_loading_kwargs)"
    )
    if new_build in src:
        print("patch SKIP: processing_gr00t_n1d7.py build_processor already patched")
    elif old_build in src:
        proc_path.write_text(src.replace(old_build, new_build))
        print("patch OK: processing_gr00t_n1d7.py build_processor → local snapshot path")
    else:
        print("patch WARN: build_processor pattern not found — processing_gr00t_n1d7.py unchanged")
else:
    print("patch SKIP: processing_gr00t_n1d7.py not found (N1.6 or different version)")
