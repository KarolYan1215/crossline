import type { Metadata } from "next";
import "./privacy.css";

export const metadata: Metadata = { title: "隐私说明 · Crossline" };
// Read at request time: the contact address comes from the server's env, which a page prerendered at build time would never see.
export const dynamic = "force-dynamic";

/**
 * 隐私说明 (decided 2026-10-17, before inviting testers to the hosted beta): what the server keeps, who else handles it, how long and how
 * it is deleted. Public — readable before signing up. Said plainly, including what is not promised (a beta can lose data).
 */
export default function PrivacyPage() {
  const contact = process.env.CROSSLINE_CONTACT_EMAIL?.trim();
  return <main className="privacy">
    <h1>隐私说明</h1>
    <p className="privacy-lede">Crossline 内测版由个人开发者运营。下面说明这台服务器保存什么、交给谁处理、保存多久、怎样删除。</p>

    <h2>保存什么</h2>
    <ul>
      <li>账号：邮箱，以及登录方式（验证码、密码或 Google）。</li>
      <li>本人提供的内容：访谈对话、上传的文件、主线与里程碑、任务与完成记录、画像报告和形象图。</li>
      <li>模型连接：每个账号在服务器上有自己的 Codex 目录，保存它的 ChatGPT 登录；填了其他模型的 API key 的，key 加密保存在服务器上，不进账本、导出和备份。都与其他账号隔离，不共享。</li>
      <li>用量：每次模型调用的时间、耗时和 token 数，用来排查故障和控制负载，不含对话内容。</li>
    </ul>

    <h2>交给谁处理</h2>
    <ul>
      <li>访谈、规划和整理由本人连接的模型完成：ChatGPT 账号按 OpenAI 的条款处理，其他模型的 API 按该服务商的条款处理，用的都是本人的额度。</li>
      <li>用开发者模型邀请码的账号，访谈、规划和整理由开发者提供的模型完成：内容经这台服务器发给硅基流动（SiliconFlow），用开发者的额度，按硅基流动的条款处理；每个账号每月有用量上限。</li>
      <li>申请邀请码时，账号邮箱和填写的理由会通过邮件发给开发者审批。</li>
      <li>画像形象图由火山方舟（字节跳动）绘制，只发送去掉个人信息的形象描述。</li>
      <li>登录验证码通过 Resend 发送邮件。</li>
      <li>不出售数据，不用于广告，不与其他账号共享。运营者能接触服务器，只在排查故障时查看日志和用量统计。</li>
    </ul>

    <h2>保存多久</h2>
    <ul>
      <li>账号存在期间一直保存。服务器每天备份，备份保留 14 天，加密的异地副本保留 30 天：删除账号后，备份里的副本最迟 30 天后消失。</li>
      <li>公开测评是独立的服务，结果 90 天后自动删除，结果邮件里有删除链接。</li>
    </ul>

    <h2>怎样删除</h2>
    <ul>
      <li>设置 → 通用 → 删除账号：输入账号邮箱确认后，上面列出的内容立即删除，无法恢复。</li>
      <li>只想断开模型：在设置 → 模型连接退出 ChatGPT 或移除其他模型，服务器上的登录或 API key 随即删除。</li>
    </ul>

    <h2>内测的限制</h2>
    <p>内测版运行在一台小服务器上，可能排队、中断或丢失数据，不承诺可用性。重要资料请自己另存一份。</p>
    {contact && <p>联系运营者：<a href={`mailto:${contact}`}>{contact}</a></p>}
    <p><a href="/login">返回登录</a></p>
  </main>;
}
