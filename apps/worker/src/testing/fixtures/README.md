# 录制下来的模型回答

这里每个 `.txt` 都是一次 Skill 运行的 `finalText` 原样，回放时逐字节喂回给 worker。

**为什么需要它们。** 三轮验收协议里大部分阻塞级缺陷都源于真实模型输出，而在这之前，
仓库里每一个测试替身回答的都是人手敲的干净 JSON —— 所以 CI 一个都看不见。这些夹具让
退化过的回答第一次走完 `worker → 校验 → 落库` 的完整路径，而不是只在纯函数层被测到。

**怎么新增一个。** 跑真实流程时设上录制目录，结果（包括被拒的那些，那才是值得留的）
会落盘：

```powershell
$env:CROSSLINE_RECORD_DIR='C:\path\to\recordings'; pnpm worker:start
```

把有价值的那份挪进来，起个说明失败形态的名字。**每发现一个新缺陷就留一个夹具。**

## 当前这几份

| 文件 | 来源 |
|---|---|
| `analysis-clean` | 一次正常回答，供修复轮返回用 |
| `analysis-degenerate-scratch-leak` | 模型把 JSON 跟丢了，在字符串里接着写：`'}], Wait final invalid.` —— 片段逐字来自真实运行 |
| `analysis-degenerate-combining-mark-padding` | 一句完整的话后面挂着同一个组合符重复四十次，把字段填到上限 —— 逐字来自真实运行 |
| `analysis-degenerate-phrase-echo` | 理由字段在自己的尾巴上循环，碎句逐次衰减 —— 逐字来自真实运行 |
| `analysis-degenerate-truncated-description` | 描述一路写到上限因而被截断，末尾还带着 `wait too long` —— 片段逐字来自真实运行 |
| `analysis-real-clean-4-contract-items` | **完全真实的一份**：放宽上限并加上 `why` 之后，录制到的第一次运行。description 6–12 字、why 32–45 字、零退化、零重试 |

四份退化夹具的**退化文本是真的**，外层 JSON 信封是按测试所用的那条捕获重建的（真实运行
里那些回答对应的是别的捕获内容）。信封是脚手架，退化文本才是被测的东西。

2026-10-03 起另有 `analysis-degenerate-zero-width-padding`：理由字段在一句完整的话后面挂着交替的零宽字符（U+200B/200C/200D），夹一个马拉雅拉姆字母和一个泄漏的 `numerusform】【。` —— 退化文本逐字来自 `scripts/structured-output-check.ts` 对一条含糊捕获（「整理一下」）的真实运行，两次运行两次都出现。旧的「同一字符重复八次」裁剪认不出交替模式，所以它曾一路存进账本。
