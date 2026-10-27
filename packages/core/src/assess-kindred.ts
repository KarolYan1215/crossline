import { TYPE_TABLE } from "./portrait-type";

/**
 * One person whose way of working is close to each type, with one line of theirs (decided with the owner, 2026-10-24): taken from the
 * 2026-10-12 shortlist (docs/plans/2026-10-12-p-e-celebrity.md task 2.1), worded as 「思想相近」 and never 「你就是某某」, with no
 * portrait. Each quote is one sentence in its original language, our own Chinese translation, and the work, talk or letter it is in;
 * the doubtful ones were checked against Wikiquote's sourced sections on 2026-10-24 (Picasso's 「Je ne cherche pas, je trouve」 is
 * listed as disputed there and was replaced). Pure data: the public app imports it in the browser and on its server.
 */
export type Kindred = {
  name: string;
  years: string;
  field: "企业家" | "文学家" | "科学家" | "艺术家" | "哲学家";
  why: string;
  quote: { original: string; translation?: string; source: string };
};

export const TYPE_KINDRED: Record<string, Kindred> = {
  ROBA: { name: "斯坦利·库布里克", years: "1928–1999", field: "艺术家", why: "一个镜头拍几十条，每一版都亲自验收",
    quote: { original: "If it can be written, or thought, it can be filmed.", translation: "能写出来、能想出来的，就能拍出来。", source: "《The Making of Kubrick's 2001》，1970" } },
  ROBG: { name: "比尔·盖茨", years: "1955–", field: "企业家", why: "搭起的是同时调度成千上万件事的系统",
    quote: { original: "We always overestimate the change that will occur in the next two years and underestimate the change that will occur in the next ten.",
      translation: "我们总是高估未来两年的变化，低估未来十年的变化。", source: "《未来之路》，1996" } },
  ROHA: { name: "沃伦·巴菲特", years: "1930–", field: "企业家", why: "把公司交给经理人，几乎不插手，只看结果",
    quote: { original: "We delegate almost to the point of abdication.", translation: "我们放权，几乎放到撒手不管的程度。", source: "伯克希尔·哈撒韦致股东信，2010" } },
  ROHG: { name: "理查德·布兰森", years: "1950–", field: "企业家", why: "同时开着几百家公司，航空、唱片、太空都做",
    quote: { original: "Screw it, let's do it.", translation: "管他呢，干就完了。", source: "同名书，2006" } },
  RUBA: { name: "艾萨克·牛顿", years: "1643–1727", field: "科学家", why: "站在前人的成果上学透，再往前走一步",
    quote: { original: "If I have seen further it is by standing on the shoulders of Giants.", translation: "如果说我看得更远，那是因为我站在巨人的肩膀上。", source: "致罗伯特·胡克的信，1676" } },
  RUBG: { name: "列奥纳多·达·芬奇", years: "1452–1519", field: "艺术家", why: "绘画、解剖、工程、飞行样样都学，每一门都留下笔记",
    quote: { original: "Iron rusts from disuse; stagnant water loses its purity.", translation: "铁不用会生锈，水不流会变浊。", source: "《达·芬奇笔记》" } },
  RUHA: { name: "理查德·费曼", years: "1918–1988", field: "科学家", why: "不轻信任何答案，先拆开自己验证一遍",
    quote: { original: "The first principle is that you must not fool yourself—and you are the easiest person to fool.", translation: "第一条原则是不要骗自己，而你自己恰恰最好骗。",
      source: "加州理工毕业演讲《草包族科学》，1974" } },
  RUHG: { name: "阿尔伯特·爱因斯坦", years: "1879–1955", field: "科学家", why: "自称没有特别的天赋，只有强烈的好奇心",
    quote: { original: "I have no special talents. I am only passionately curious.", translation: "我没有什么特别的天赋，只是好奇心特别强。", source: "致卡尔·泽利希的信，1952" } },
  WOBA: { name: "艾伦·图灵", years: "1912–1954", field: "科学家", why: "最早认真想过人和机器怎么一起思考",
    quote: { original: "We can only see a short distance ahead, but we can see plenty there that needs to be done.", translation: "我们只能看到前方不远的地方，但能看到那里有很多事要做。",
      source: "《计算机器与智能》，1950" } },
  WOBG: { name: "杰夫·贝索斯", years: "1964–", field: "企业家", why: "一艘大船同时开着电商、云、物流和航天几条航线",
    quote: { original: "Day 2 is stasis. Followed by irrelevance.", translation: "第二天就是停滞，接着就是无足轻重。", source: "亚马逊致股东信，2016" } },
  WOHA: { name: "巴勃罗·毕加索", years: "1881–1973", field: "艺术家", why: "同样是光头；画一张毁一张，边画边改",
    quote: { original: "I do a picture — then I destroy it.", translation: "我画一幅画，然后毁掉它。", source: "泽沃斯访谈，《艺术手册》，1935" } },
  WOHG: { name: "马克·吐温", years: "1835–1910", field: "文学家", why: "一辈子到处走、到处写，旅行本身就是工作",
    quote: { original: "Travel is fatal to prejudice, bigotry, and narrow-mindedness.", translation: "旅行是偏见、固执和狭隘的克星。", source: "《傻子出国记》，1869" } },
  WUBA: { name: "老子", years: "春秋", field: "哲学家", why: "向内修炼，先认清自己",
    quote: { original: "知人者智，自知者明。", source: "《道德经》第三十三章" } },
  WUBG: { name: "尼科洛·马基雅维利", years: "1469–1527", field: "哲学家", why: "替君主推演每一步，冷静地算清局势",
    quote: { original: "la fortuna sia arbitra della metà delle azioni nostre, ma che etiam lei ne lasci governare l'altra metà, o presso, a noi.",
      translation: "命运主宰我们一半的行动，另一半（或差不多一半）留给我们自己。", source: "《君主论》第二十五章，1532" } },
  WUHA: { name: "玛丽·居里", years: "1867–1934", field: "科学家", why: "在棚屋里一锅一锅提炼镭，失败了再来",
    quote: { original: "One never notices what has been done; one can only see what remains to be done.", translation: "人们从不留意已经做成了什么，只看得到还剩什么没做。",
      source: "致兄长的信，1894" } },
  WUHG: { name: "米歇尔·德·蒙田", years: "1533–1592", field: "哲学家", why: "什么都想聊一聊，又总问一句「我知道什么」",
    quote: { original: "Que sais-je ?", translation: "我知道什么？", source: "《随笔集》第二卷第十二章" } }
};

/** Every type has its kindred person (checked in assess-content.test.ts). */
export const kindredOf = (code: string): Kindred | undefined => (TYPE_TABLE[code] ? TYPE_KINDRED[code] : undefined);
