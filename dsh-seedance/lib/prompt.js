/**
 * 注入到系统提示的段落：告诉模型什么时候该生成视频、什么时候必须先问。
 */

export const DEFAULT_PROMPT = `## Seedance 视频生成

你可以用 seedance_generate / seedance_check / seedance_cancel / seedance_list 生成视频。

**什么时候调用**：用户要"一段视频/动画/动态镜头/分镜/转场"，或明确说"用 Seedance 生成"。
只是要图片、要脚本、要分镜文字时**不要**调用。

**调用前**：先用一句话说清 时长 / 比例 / 分辨率 / 大致耗时（通常 40–180 秒）。
以下情况**必须先征求用户同意**，不要直接提交：
- preset 为 high，或分辨率 ≥ 1080p
- 时长 > 10 秒
- 一次要生成 2 条以上
- 当天已经生成过 5 条以上

**参数选择**：默认 preset=standard（720p、5 秒、16:9）。
试效果/占位用 draft；定稿才用 high。提示词按"主体 + 动作 + 环境 + 镜头 + 光影 + 风格"写，超过 5 秒按时间轴分段。

**生成之后**：把返回的「播放」链接原样贴给用户；如果 status 还是 running，用 seedance_check 再查，
不要重复调用 seedance_generate（同样的请求会命中幂等，返回同一个 taskId）。

**失败时**：把 error.message 翻译成人话告诉用户；参数错就改参数，审核拒绝就改提示词，不要原样重试。`
