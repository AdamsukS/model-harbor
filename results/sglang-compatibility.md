# SGLang Apple Metal compatibility result

Tested on 2026-09-03 with:

- Apple M4, 16 GiB unified memory
- Python 3.12.13
- SGLang commit `27b7a2dc3baf6b93736540e35c1847efdfb56436`
- SGLang `0.0.0.dev1+g27b7a2dc3.d20260903`
- MLX `0.32.2`
- PyTorch `2.13.0`
- model `mlx-community/Qwen3.5-9B-4bit`, local revision
  `8b2b98c00a6b4d291155e4890773ca8f769aee53`

## Result

The optional SGLang runtime and its `srt_mps` dependencies install successfully,
but the server cannot start this model. Qwen3.5 uses a hybrid Mamba architecture;
SGLang's model-specific setup currently asserts that its Mamba extra buffer needs
CUDA, MUSA, NPU, ROCm, or XPU. Apple Metal is not accepted by that path.

The relevant terminal error was:

```text
AssertionError: extra_buffer needs CUDA/MUSA/NPU/ROCm/XPU (FLA).
```

The reproducible preparation and launch commands remain available as
`scripts/prepare-sglang.sh` and `scripts/start-sglang.sh`. SGLang is not the
default backend; the verified MLX-LM service remains the supported baseline.

The machine only has the Xcode Command Line Tools, so SGLang's optional custom
Metal kernels were not compiled. That is separate from the blocking Mamba
platform assertion above.
