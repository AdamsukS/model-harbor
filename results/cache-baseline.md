# KV / Prompt Cache Baseline

Runtime measurements are appended by `scripts/bench-cache.sh`. Profiles must run in the order 32K, 64K, then 128K.

| Profile | Cache entries | Cache cap | Scenario | Prompt tokens | Cached tokens | TTFT (s) | Total (s) | Peak RSS (GiB) | Result |
|---|---:|---:|---|---:|---:|---:|---:|---:|---|
| 32k | 5 | 2GB | cold | 32728 | 0 | 198.606 | 198.783 | 1.665 | pass |
| 32k | 5 | 2GB | shared_prefix_hot | 32727 | 32714 | 0.877 | 0.965 | 1.500 | pass |
| 32k | 5 | 2GB | different_prefix | 0 | 0 | 0.000 | 203.838 | 1.500 | fail: RuntimeError: swap growth reached the 1 GiB safety limit |
| 32k | 1 | 1200MB | cold | 32728 | 0 | 197.879 | 198.055 | 5.112 | pass |
| 32k | 1 | 1200MB | shared_prefix_hot | 32727 | 32714 | 0.843 | 0.938 | 4.924 | pass |
| 32k | 1 | 1200MB | different_prefix | 32721 | 0 | 202.759 | 202.840 | 4.924 | pass |
