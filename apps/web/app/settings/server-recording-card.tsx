"use client";

import { useEffect, useState } from "react";
import type { RecordingOverview } from "../../lib/recordings";
import { SegmentedControl } from "../ui/controls";

/**
 * 录音在服务器转写 (docs/phone-recording.md 「服务器转写」): the phone's shortcut uploads recordings with a token of their own, the server
 * transcribes them in the person's night and deletes the audio. Off by default; turning it off deletes what still waits and asks what
 * becomes of the transcripts.
 */
export function ServerRecordingCard({ server, done }: { server: NonNullable<RecordingOverview["server"]>; done: number }) {
  const [on, setOn] = useState(server.on);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [token, setToken] = useState("");
  const [origin, setOrigin] = useState("");
  useEffect(() => { setOrigin(window.location.origin); }, []);

  const save = async (next: boolean, keep?: boolean) => {
    const response = await fetch("/api/settings/recordings/server", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(keep === undefined ? { on: next } : { on: next, keep }) }).catch(() => undefined);
    if (!response?.ok) { setNote("未保存，请重试"); return; }
    const result = await response.json() as { deleted: number; discarded: number };
    setOn(next); setAsking(false);
    setNote(next ? "已开启：生成上传令牌后按下面的步骤设置快捷指令"
      : `已关闭，已删除 ${result.discarded} 个还没转写的录音${keep ? "，已转写的文字保留" : `和 ${result.deleted} 份转写文字`}`);
  };
  const issue = async () => {
    const response = await fetch("/api/health/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "recording" }) }).catch(() => undefined);
    const body = await response?.json().catch(() => null) as { token?: string } | null;
    if (!body?.token) { setNote("未能生成，请重试"); return; }
    setToken(body.token);
    setNote("令牌只显示这一次；重新生成后旧的立即失效。");
  };
  const endpoint = `${origin || "https://<网址>"}/api/recordings/upload?name=`;

  return <section className="st-card" aria-label="录音在服务器转写">
    <header><h3>录音在服务器转写</h3><small>手机快捷指令把录音上传到服务器，本人时区夜间 1–6 点用 SenseVoice 转写成文字放进材料；录音转完即删，不进备份</small></header>
    <div className="st-row"><span className="st-row-label">服务器转写<small>{on ? "开启" : "关闭"}；录音会离开本人的设备</small></span>
      <SegmentedControl label="录音在服务器转写" value={on ? "on" : "off"} onChange={(next) => { if (next === "on") void save(true); else if (on) setAsking(true); }}
        options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} /></div>
    {asking && <div className="st-row st-row-wrap" role="group" aria-label="关闭后已转写的文字">
      <span className="st-row-label">还没转写的录音会删除；已转写的 {done} 份文字<small>关闭后不再接收上传</small></span>
      <span className="st-row-actions">
        <button type="button" onClick={() => void save(false, true)}>关闭并保留文字</button>
        <button type="button" onClick={() => void save(false, false)}>关闭并删除文字</button>
        <button type="button" onClick={() => setAsking(false)}>取消</button>
      </span></div>}
    {note && <p role="status" className="st-note">{note}</p>}
    {on && <>
      <p className="st-note">等待转写 {server.waiting} 个。转完的录音会整理成摘要：闲聊和视频声不保留，本人答应做的事记为收集，需本人确认后才排进日程。</p>
      <div className="st-row st-row-wrap"><span className="st-row-label">上传令牌<small>只能上传录音，不能读任何内容</small></span>
        <button type="button" onClick={() => void issue()}>{token ? "重新生成" : "生成上传令牌"}</button></div>
      {token && <ul className="st-list" aria-label="快捷指令要填的内容">
        <li><span>网址</span><small className="mono">{endpoint}</small></li>
        <li><span>请求头 Authorization</span><small className="mono">Bearer {token}</small></li>
      </ul>}
      <details className="st-details"><summary>快捷指令怎么设</summary>
        <ol className="st-steps">
          <li>「快捷指令」App → 新建快捷指令，命名「上传到 Crossline」；在「ⓘ」里打开「在共享表单中显示」，接收类型只留「媒体」。</li>
          <li>加「获取名称」（输入：快捷指令输入），再加「URL 编码」编码这个名称。</li>
          <li>加「获取 URL 内容」：网址填上面的网址并在末尾接上编码后的名称，方法 POST，请求头 Authorization 填上面的值，请求体选「文件」，文件选「快捷指令输入」。</li>
          <li>用 iPhone 自带的「语音备忘录」录音（锁屏后继续录）；录完点开这条录音 →「…」→「共享」→「上传到 Crossline」。</li>
          <li>iOS 26 可试全自动：「自动化」→「App」→「语音备忘录」→「已关闭」→「立即运行」，动作为「查找录音」（过去 1 天内）→「重复每一项」→ 同样的上传。若「查找录音」给不出文件，就用上一步手动分享。</li>
        </ol>
        <p className="st-note">不用另装 App。同一个录音传两次只转一次。录音时别的 App 放声音，语音备忘录会停录。单个录音不超过 300 MB，每天合计不超过 3 GB。</p>
      </details>
    </>}
    {server.failed.length > 0 && <ul className="st-list" aria-label="没有转写成的上传">{server.failed.map((item, index) =>
      <li key={`${item.file}-${index}`}><span>{item.file}</span><small>{item.note}</small></li>)}</ul>}
    <p className="st-note">录到别人说话前，需让对方知情，并遵守当地关于录音的法律。</p>
  </section>;
}
