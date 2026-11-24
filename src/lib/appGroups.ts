import bundledFeatured from "../../catalog/featured.json";
import type { FeaturedCatalog, LocalAppCandidate } from "@/types";

export const MENUBAR_GROUP = "菜单栏常驻";

export const UNIFIED_APP_GROUPS = [
  "浏览与网络",
  "AI 工具",
  "日常办公",
  "软件开发",
  "游戏开发",
  "设计创作",
  "影音娱乐",
  "游戏平台",
  "系统与工具",
  MENUBAR_GROUP,
] as const;

export const OTHER_GROUP = "其他应用";

export interface StarterPackSlot {
  group: string;
  groupIndex: number;
  appIndex: number;
  isMenubar: boolean;
}

const catalog = bundledFeatured as FeaturedCatalog;

const byCask = new Map<string, string>();
const byAppFile = new Map<string, string>();
const byName = new Map<string, string>();

const starterByCask = new Map<string, StarterPackSlot>();
const starterByAppFile = new Map<string, StarterPackSlot>();
const starterByName = new Map<string, StarterPackSlot>();

const featuredById = new Map(catalog.apps.map((a) => [a.id, a]));

export const STARTER_PACK_GROUP_ORDER: string[] = [];

(catalog.starter_pack || []).forEach((spGroup, groupIndex) => {
  const isMenubar = spGroup.group === MENUBAR_GROUP;
  if (!isMenubar && !STARTER_PACK_GROUP_ORDER.includes(spGroup.group)) {
    STARTER_PACK_GROUP_ORDER.push(spGroup.group);
  }
  spGroup.apps.forEach((appId, appIndex) => {
    const app = featuredById.get(appId);
    if (!app) return;
    const slot: StarterPackSlot = {
      group: spGroup.group,
      groupIndex,
      appIndex,
      isMenubar,
    };
    starterByName.set(app.name.toLowerCase(), slot);
    for (const c of app.brew_casks || []) {
      starterByCask.set(c.toLowerCase(), slot);
    }
    for (const d of app.dock_apps || []) {
      starterByAppFile.set(d.toLowerCase(), slot);
      starterByName.set(d.replace(/\.app$/i, "").toLowerCase(), slot);
    }
  });
});

export function matchStarterPackSlot(
  app: LocalAppCandidate
): StarterPackSlot | null {
  if (app.brew_cask) {
    const hit = starterByCask.get(app.brew_cask.toLowerCase());
    if (hit) return hit;
  }
  const byFile = starterByAppFile.get(app.app_name.toLowerCase());
  if (byFile) return byFile;

  const byDisplay = starterByName.get(app.name.toLowerCase());
  if (byDisplay) return byDisplay;

  return null;
}

for (const app of catalog.apps) {
  const isMenubarOnly =
    app.kind === "cask" && (!app.dock_apps || app.dock_apps.length === 0);
  const cat = isMenubarOnly ? MENUBAR_GROUP : app.category;
  if (!cat) continue;
  byName.set(app.name.toLowerCase(), cat);
  for (const c of app.brew_casks || []) {
    byCask.set(c.toLowerCase(), cat);
  }
  for (const d of app.dock_apps || []) {
    byAppFile.set(d.toLowerCase(), cat);
    byName.set(d.replace(/\.app$/i, "").toLowerCase(), cat);
  }
}

const MENUBAR_KEYWORDS: string[] = [
  "snipaste",
  "jetbrains toolbox",
  "jetbrains-toolbox",
  "shottr",
  "cleanshot",
  "bob",
  "input source",
  "input-source",
  "rectangle",
  "magnet",
  "moom",
  "alttab",
  "bartender",
  "hidden bar",
  "jordanbaird-ice",
  "stats",
  "istat",
  "monitorcontrol",
  "betterdisplay",
  "lunar",
  "aldente",
  "amphetamine",
  "caffeine",
  "maccy",
  "popclip",
  "karabiner",
  "hammerspoon",
  "bettertouchtool",
];

const KEYWORD_RULES: [string, string[]][] = [
  [
    "浏览与网络",
    [
      "chrome",
      "arc",
      "firefox",
      "edge",
      "brave",
      "opera",
      "vivaldi",
      "zen",
      "dia",
      "clash",
      "surge",
      "shadowrocket",
      "mihomo",
      "v2ray",
      "tailscale",
      "wireguard",
      "vpn",
      "proxy",
      "netdisk",
      "baidu",
      "quark",
      "aliyunpan",
      "motrix",
      "downie",
      "localsend",
      "transmit",
      "filezilla",
      "thunder",
      "迅雷",
      "网盘",
    ],
  ],
  [
    "AI 工具",
    [
      "chatgpt",
      "claude",
      "openai",
      "gemini",
      "ollama",
      "lm studio",
      "cherry studio",
      "doubao",
      "豆包",
      "yuanbao",
      "元宝",
      "kimi",
      "deepseek",
      "poe",
      "perplexity",
      "jan",
      "chatbox",
      "workbuddy",
    ],
  ],
  [
    "日常办公",
    [
      "wechat",
      "weixin",
      "微信",
      "qq",
      "feishu",
      "lark",
      "飞书",
      "dingtalk",
      "钉钉",
      "slack",
      "telegram",
      "discord",
      "zoom",
      "meeting",
      "teams",
      "mail",
      "outlook",
      "spark",
      "thunderbird",
      "whatsapp",
      "signal",
      "腾讯会议",
      "企业微信",
      "邮箱",
      "notion",
      "obsidian",
      "yuque",
      "语雀",
      "logseq",
      "typora",
      "bear",
      "craft",
      "evernote",
      "onenote",
      "wps",
      "word",
      "excel",
      "powerpoint",
      "keynote",
      "pages",
      "numbers",
      "raycast",
      "alfred",
      "snipaste",
      "shottr",
      "cleanshot",
      "bob",
      "eudic",
      "欧路",
      "xmind",
      "mindnode",
      "ticktick",
      "滴答",
      "todoist",
      "things",
      "calendar",
      "paste",
      "maccy",
      "popclip",
    ],
  ],
  [
    "软件开发",
    [
      "code",
      "cursor",
      "trae",
      "windsurf",
      "antigravity",
      "openidea",
      "xcode",
      "jetbrains",
      "intellij",
      "idea",
      "webstorm",
      "pycharm",
      "goland",
      "datagrip",
      "clion",
      "rider",
      "android studio",
      "sublime",
      "zed",
      "neovim",
      "iterm",
      "ghostty",
      "warp",
      "alacritty",
      "kitty",
      "terminal",
      "docker",
      "orbstack",
      "postman",
      "bruno",
      "apifox",
      "insomnia",
      "tableplus",
      "navicat",
      "dbeaver",
      "github",
      "fork",
      "sourcetree",
      "tower",
      "charles",
      "proxyman",
      "wireshark",
      "redis",
      "termius",
      "finalshell",
    ],
  ],
  [
    "游戏开发",
    [
      "unity",
      "unreal",
      "godot",
      "blender",
      "cocos",
      "aseprite",
      "tiled",
      "spine",
      "substance",
      "maya",
      "houdini",
      "cinema 4d",
      "gamemaker",
      "rpg maker",
    ],
  ],
  [
    "设计创作",
    [
      "figma",
      "sketch",
      "photoshop",
      "illustrator",
      "premiere",
      "after effects",
      "lightroom",
      "adobe",
      "affinity",
      "pixelmator",
      "final cut",
      "davinci",
      "jianying",
      "capcut",
      "剪映",
      "screen studio",
      "obs",
      "logic pro",
      "ableton",
      "mastergo",
      "pixso",
      "canva",
    ],
  ],
  [
    "影音娱乐",
    [
      "music",
      "spotify",
      "netease",
      "网易云",
      "qqmusic",
      "qq音乐",
      "bilibili",
      "哔哩哔哩",
      "iina",
      "vlc",
      "mpv",
      "infuse",
      "plex",
      "netflix",
      "youtube",
      "kindle",
      "calibre",
      "potplayer",
    ],
  ],
  [
    "游戏平台",
    [
      "steam",
      "epic",
      "battle.net",
      "wegame",
      "gog",
      "ea app",
      "origin",
      "ubisoft",
      "minecraft",
      "ryujinx",
      "dolphin",
      "retroarch",
      "openemu",
      "crossover",
      "whisky",
    ],
  ],
  [
    "系统与工具",
    [
      "input source",
      "rectangle",
      "magnet",
      "moom",
      "alttab",
      "bartender",
      "ice",
      "hidden bar",
      "stats",
      "istat",
      "monitorcontrol",
      "betterdisplay",
      "lunar",
      "keka",
      "unarchiver",
      "appcleaner",
      "pearcleaner",
      "cleanmymac",
      "1password",
      "bitwarden",
      "keepass",
      "karabiner",
      "hammerspoon",
      "bettertouchtool",
      "aldente",
      "amphetamine",
      "caffeine",
      "coconutbattery",
      "daisydisk",
      "vmware",
      "parallels",
      "utm",
      "logi",
      "razer",
      "sogou",
      "搜狗",
      "rime",
      "鼠须管",
    ],
  ],
];

export function classifyLocalApp(app: LocalAppCandidate): string {
  if (app.brew_cask) {
    const hit = byCask.get(app.brew_cask.toLowerCase());
    if (hit) return hit;
  }
  const byFile = byAppFile.get(app.app_name.toLowerCase());
  if (byFile) return byFile;

  const lowerName = app.name.toLowerCase();
  const hitName = byName.get(lowerName);
  if (hitName) return hitName;

  const haystack = `${lowerName} ${app.app_name.toLowerCase()} ${(
    app.brew_cask || ""
  ).toLowerCase()}`;

  if (MENUBAR_KEYWORDS.some((kw) => haystack.includes(kw))) {
    return MENUBAR_GROUP;
  }

  for (const [group, keywords] of KEYWORD_RULES) {
    if (keywords.some((kw) => haystack.includes(kw))) {
      return group;
    }
  }

  return OTHER_GROUP;
}
