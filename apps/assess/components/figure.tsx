import type { AvatarStatus, PublicType } from "../lib/contract";
import { smallFigure } from "./poster";

/** How often a figure still being drawn is checked on. */
export const AVATAR_POLL_MS = 5_000;
export const isDrawing = (avatar: AvatarStatus): boolean => avatar.state === "queued" || avatar.state === "drawing";

/**
 * A person's figure, shown small (the invitation, the pair page): their own drawn figure once it exists, else a tile of the type's
 * code on the group's tint — never the type's shared template, which on someone's own result read as "not me" (decided 2026-10-16).
 * While it is being drawn the tile breathes slowly (still under reduced motion).
 */
export function FigureTile({ avatar, type, alt, width, height }: { avatar: AvatarStatus; type: PublicType; alt: string; width: number; height: number }) {
  // eslint-disable-next-line @next/next/no-img-element -- a figure, a plain image
  if (avatar.state === "ready") return <img className="as-figure" src={smallFigure(avatar.url)} alt={alt} width={width} height={height} />;
  const waiting = isDrawing(avatar);
  return <div className="as-figure as-figure-tile" data-waiting={waiting || undefined} role="img"
    aria-label={waiting ? `${alt}正在画` : type.name}>
    <span aria-hidden="true">{type.name}</span>
  </div>;
}

/** In place of the poster while the person's figure is being drawn: no template, no half-made poster to save by mistake. */
export function DrawingCard({ type }: { type: PublicType }) {
  return <div className="as-drawing" role="status">
    <div className="as-drawing-figure" aria-hidden="true"><span>{type.name}</span><i /></div>
    <p className="as-drawing-title">正在画你的专属形象</p>
    <p className="as-note">按你选的外貌来画，通常一两分钟；同时测的人多时要排队，可能要等几分钟。画好后海报会出现在这里，不用刷新；也可以先离开，结果链接已发到你的邮箱。</p>
  </div>;
}
