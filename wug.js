const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs").promises;
const path = require("path");
const { RateLimiter } = require("limiter");
const lockFile = require("lockfile");

// === 添加技能系统定义 ===
const SKILLS = {
  1: {
    id: 1,
    name: "独孤九剑",
    description: "剑法精妙，造成150%攻击伤害",
    damageMultiplier: 1.5,
    cost: 20,
    cooldown: 3, // 分钟
  },
  2: {
    id: 2,
    name: "金钟罩",
    description: "提升防御50%，持续2回合",
    defenseMultiplier: 1.5,
    cost: 15,
    duration: 2,
  },
  3: {
    id: 3,
    name: "凌波微步",
    description: "闪避下次攻击并反击",
    cost: 25,
    dodge: true,
    cooldown: 4, // 添加冷却时间(分钟)
  },
};

const LOCK_FILE = path.join(__dirname, "bot.lock");

// 检查是否已有实例运行
if (lockFile.checkSync(LOCK_FILE)) {
  console.error("另一个机器人实例已在运行！");
  process.exit(1);
}

// 创建锁文件
lockFile.lockSync(LOCK_FILE, { retries: 0 }); // 添加选项防止重试

// 退出时删除锁文件
const cleanupLock = () => {
  try {
    if (lockFile.checkSync(LOCK_FILE)) {
      lockFile.unlockSync(LOCK_FILE);
    }
  } catch (e) {
    console.error("删除锁文件时出错:", e);
  }
};

// 捕获所有可能的退出信号
process.on("exit", cleanupLock);
process.on("SIGINT", () => {
  cleanupLock();
  process.exit();
});
process.on("SIGTERM", () => {
  cleanupLock();
  process.exit();
});
process.on("uncaughtException", (err) => {
  console.error("未捕获异常:", err);
  cleanupLock();
  process.exit(1);
});

// === 配置和常量 ===
const BOT_TOKEN = "7588851384:AAGLCQg4EVeYpgcCccvjwwCmrfxRgQCPkWw"; // 确保正确
const ADMIN_ID = 6344426539;
const DATA_FILE = path.join(__dirname, "data.json");

// 新增装备类型和品质常量
const EQUIP_TYPES = ["weapon", "armor", "helmet", "boots", "accessory"];
const EQUIP_RARITY = ["普通", "精良", "稀有", "史诗", "传说"];
const EQUIP_SET_BONUS = {
  3: { attack: 15, defense: 10 },
  5: { attack: 30, defense: 20, health: 100 },
};

// === 在这里定义 globalConfig ===
let globalConfig = {
  invincibleMode: false,
  lastMonsterSpawn: 0,
  monsterSpawnInterval: 30 * 60 * 1000, // 30分钟
  partyBonus: 1.2, // 组队经验加成
  skillCooldown: 5 * 60 * 1000, // 技能冷却时间
};

// 全局数据
let users = {};
let groups = {};
let monsters = {};
let clans = {};

// 初始化机器人
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// 添加速率限制器
const limiter = new RateLimiter({
  tokensPerInterval: 20,
  interval: "second",
});

// === 安全发送消息函数 ===
async function safeSendMessage(chatId, text, options = {}) {
  try {
    // 等待可用的请求令牌
    await limiter.removeTokens(1);
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    if (error.response && error.response.statusCode === 429) {
      const retryAfter = error.response.parameters.retry_after || 5;
      console.warn(`Rate limited. Retrying after ${retryAfter} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return safeSendMessage(chatId, text, options);
    }
    throw error;
  }
}

// init() 函数放在 globalConfig 定义之后
async function init() {
  try {
    const data = await fs.readFile(DATA_FILE, "utf8");
    const parsedData = JSON.parse(data);
    users = parsedData.users || {};
    groups = parsedData.groups || {};
    clans = parsedData.clans || parsedData.门派s || {}; // 兼容旧数据

    // 确保 globalConfig 存在 - 直接合并默认配置
    globalConfig = {
      invincibleMode: false,
      lastMonsterSpawn: 0,
      monsterSpawnInterval: 30 * 60 * 1000, // 30分钟
      partyBonus: 1.2, // 组队经验加成
      skillCooldown: 5 * 60 * 1000, // 技能冷却时间
      ...(parsedData.globalConfig || {}), // 合并已保存的配置
    };

    console.log("数据加载成功");
  } catch (error) {
    console.log("初始化新数据文件，使用默认配置");
    // 确保全局配置存在
    globalConfig = {
      invincibleMode: false,
      lastMonsterSpawn: 0,
      monsterSpawnInterval: 30 * 60 * 1000,
      partyBonus: 1.2,
      skillCooldown: 5 * 60 * 1000,
    };
  }

  // 启动怪物生成定时器 - 确保在数据加载后启动
  setInterval(spawnRandomMonster, globalConfig.monsterSpawnInterval);

  // 每小时触发一次江湖奇遇
  setInterval(() => {
    const groupIds = Object.keys(groups);
    if (groupIds.length > 0 && Math.random() < 0.3) {
      const randomGroupId =
        groupIds[Math.floor(Math.random() * groupIds.length)];
      triggerRandomEvent(randomGroupId);
    }
  }, 60 * 60 * 1000);

  console.log("机器人已启动");
}

// === 全局错误捕捉（放在 safeSendMessage 定义之后）===
process.on("uncaughtException", async (err) => {
  console.error("Uncaught Exception:", err);
  try {
    await safeSendMessage(ADMIN_ID, `系统错误: ${err.message}`);
  } catch (error) {
    console.error("Failed to send error message:", error);
  }
});

process.on("unhandledRejection", async (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  try {
    await safeSendMessage(ADMIN_ID, `未处理的Promise拒绝: ${reason.message}`);
  } catch (error) {
    console.error("Failed to send error message:", error);
  }
});

// 后续代码...

// 初始化中间件
bot.on("message", async (msg) => {
  try {
    // 忽略机器人消息
    if (msg.from.is_bot) return;

    // 记录消息时间用于冷却计算
    if (msg.from.id) {
      users[msg.from.id] = users[msg.from.id] || createNewUser(msg.from);
      users[msg.from.id].lastMessageTime = Date.now();

      // 检查消息是否符合修炼条件
      if (msg.text && msg.text.length >= 5) {
        users[msg.from.id].messageCount++;
        if (users[msg.from.id].messageCount >= 3) {
          users[msg.from.id].messageCount = 0;
          addExp(msg.from.id, 1);
          await safeSendMessage(
            msg.chat.id,
            `「${msg.from.first_name}」通过聊天获得了1点经验！`
          );
        }
      }

      // 随机技能学习机会（0.2%概率）- 只保留一处
      if (msg.text && msg.text.startsWith("/learn") && Math.random() < 0.002) {
        const availableSkills = Object.values(SKILLS).filter(
          (skill) => !users[msg.from.id].skills.includes(skill.id)
        );

        if (availableSkills.length > 0) {
          const skill =
            availableSkills[Math.floor(Math.random() * availableSkills.length)];
          users[msg.from.id].skills.push(skill.id);
          await safeSendMessage(
            msg.chat.id,
            `✨ 你在江湖历练中领悟了新武学「${skill.name}」！\n` +
              `使用 /skill ${skill.name} 施展此招`
          );
        }
      }
    }

    // 保存数据
    await saveData();
  } catch (error) {
    console.error("中间件错误:", error);
    await safeSendMessage(ADMIN_ID, `中间件错误: ${error.message}`);
  }
});

// 新增江湖奇遇触发函数 - 添加完整实现
function triggerRandomEvent(chatId) {
  const events = [
    {
      name: "神秘老人",
      description: "一位神秘老人出现在群中，他似乎想传授武功",
      actions: ["/learn 降龙十八掌", "/ignore"],
    },
    {
      name: "武林秘宝",
      description: "有人发现了一处藏宝地，内含珍贵装备",
      actions: ["/search", "/leave"],
    },
    {
      name: "门派挑战",
      description: "其他门派前来挑战，捍卫门派荣誉的时刻到了！",
      actions: ["/accept_challenge", "/decline"],
    },
  ];

  const event = events[Math.floor(Math.random() * events.length)];
  let message = `✨【江湖奇遇】✨\n${event.name}\n\n${event.description}\n\n`;

  event.actions.forEach((action, i) => {
    message += `${i + 1}. ${action}\n`;
  });

  safeSendMessage(chatId, message);
}

// 管理员命令处理
bot.onText(/^\/admin/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (userId !== ADMIN_ID) {
      return bot.sendMessage(chatId, "你不是管理员，无权使用此命令！");
    }

    const command = msg.text.split(" ")[1];

    switch (command) {
      case "boos":
        globalConfig.invincibleMode = true;
        await safeSendMessage(chatId, "已开启无敌模式！");
        break;
      case "sss":
        globalConfig.invincibleMode = false;
        await safeSendMessage(chatId, "已关闭无敌模式，恢复普通模式！");
        break;
      default:
        safeSendMessage(
          chatId,
          "可用命令: /admin boos (无敌模式) /admin sss (普通模式)"
        );
    }
  } catch (error) {
    console.error("管理员命令错误:", error);
    await safeSendMessage(ADMIN_ID, `管理员命令错误: ${error.message}`);
  }
});

// ===========================
// 玩家命令处理部分（完整代码）
// ===========================

// 1. 基础命令
bot.onText(/^\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!users[userId]) {
      users[userId] = createNewUser(msg.from);
      await saveData();
      await safeSendMessage(
        chatId,
        `欢迎加入江湖，「${msg.from.first_name}」！你已创建角色，开始你的武侠之旅吧！`
      );
      await safeSendMessage(
        chatId,
        `使用 /me 查看角色信息\n使用 /help 查看帮助指南`
      );
    } else {
      await safeSendMessage(
        chatId,
        `「${msg.from.first_name}」，你已经有角色了，无需重新创建。`
      );
    }
  } catch (error) {
    console.error("/start命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/start命令错误: ${error.message}`);
  }
});

bot.onText(/^\/help/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const helpText = `
🎮 武侠机器人命令指南：

🛡️ 角色管理：
/start - 创建角色
/me - 查看个人资料
/cultivate - 修炼武功

⚔️ 战斗系统：
/fight [怪物ID] - 攻击怪物
/use [技能名] - 使用技能
/myskills - 查看已学技能

👥 组队系统：
/invite @用户名 - 邀请玩家
/accept - 接受邀请
/leave - 离开队伍
/party - 队伍信息

🏯 门派系统：
/createclan [门派名] - 创建门派(需66级和5000金币)
/joinclan [门派ID] - 加入门派
/leaveclan - 退出门派
/clans - 门派列表
🎁 其他：
/daily - 每日奖励
⚔️ PK系统：
/pk @对手 - 发起1v1挑战
/clan_pk [门派ID] - 发起门派战

🎯 战斗奖励：
胜利者：金币+100、灵力+10、经验+10、随机装备
失败者：经验-10

🏯 门派战奖励：
胜方成员：金币+200、灵力+10、经验+20、随机装备
败方成员：经验-10
`;

    await safeSendMessage(chatId, helpText);
  } catch (error) {
    console.error("/help命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/help命令错误: ${error.message}`);
  }
});

bot.onText(/^\/me/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    const user = users[userId];
    const profile = generateProfileText(user);
    await safeSendMessage(chatId, profile);
  } catch (error) {
    console.error("/me命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/me命令错误: ${error.message}`);
  }
});

// 添加在玩家命令处理部分
bot.onText(/^\/pk (.+)/, async (msg, match) => {
  try {
    const targetUsername = match[1].replace("@", "");
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    // 查找目标玩家
    const targetUser = Object.values(users).find(
      (u) =>
        u.name.includes(targetUsername) || u.id.toString() === targetUsername
    );

    if (!targetUser) {
      return await safeSendMessage(chatId, `找不到玩家「${targetUsername}」！`);
    }

    if (userId === targetUser.id) {
      return await safeSendMessage(chatId, "不能和自己对战！");
    }
    console.log(userList);

    // 检查冷却时间（5分钟）
    const now = Date.now();
    if (
      users[userId].lastPkTime &&
      now - users[userId].lastPkTime < 5 * 60 * 1000
    ) {
      const cooldown = Math.ceil(
        (5 * 60 * 1000 - (now - users[userId].lastPkTime)) / 60000
      );
      return await safeSendMessage(
        chatId,
        `PK冷却中，请${cooldown}分钟后再战！`
      );
    }

    // 开始PK
    const battleLog = [];
    const result = await simulateBattle(userId, targetUser.id, battleLog);

    // 更新冷却时间
    users[userId].lastPkTime = now;
    users[targetUser.id].lastPkTime = now;

    // 发送战斗过程
    const battleText =
      "⚔️【武林对决】⚔️\n" +
      `「${users[userId].name}」 vs 「${targetUser.name}」\n\n` +
      battleLog.join("\n") +
      "\n\n" +
      result.message;

    await safeSendMessage(chatId, battleText);

    // 处理奖励/惩罚
    if (result.winner === userId) {
      await handlePkReward(userId, 100, 10, 10);
      addExp(targetUser.id, -10); // 失败者经验扣除
      await safeSendMessage(
        chatId,
        `🎉 胜者「${users[userId].name}」获得奖励：\n` +
          `💰 +100金币 | ✨ +10灵力 | 📈 +10经验\n` +
          `💔 败者「${targetUser.name}」损失10点经验`
      );
    } else {
      await handlePkReward(targetUser.id, 100, 10, 10);
      addExp(userId, -10);
      await safeSendMessage(
        chatId,
        `🎉 胜者「${targetUser.name}」获得奖励：\n` +
          `💰 +100金币 | ✨ +10灵力 | 📈 +10经验\n` +
          `💔 败者「${users[userId].name}」损失10点经验`
      );
    }

    await saveData();
  } catch (error) {
    console.error("/pk命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/pk命令错误: ${error.message}`);
  }
});

// PK奖励处理
async function handlePkReward(winnerId, gold, spirit, exp) {
  const user = users[winnerId];
  user.gold += gold;
  user.spirit = Math.min(user.maxSpirit, user.spirit + spirit);
  addExp(winnerId, exp);

  // 30%几率获得装备
  if (Math.random() < 0.3) {
    const equip = generateEquipment(user.level);
    user.inventory.push(equip);
    await safeSendMessage(
      winnerId,
      `🎁 获得战利品: ${equip.name}\n` +
        `⚔️ 攻击+${equip.attack} | 🛡️ 防御+${equip.defense}`
    );
  }
}

// 战斗模拟
async function simulateBattle(attackerId, defenderId, battleLog) {
  const attacker = { ...users[attackerId] };
  const defender = { ...users[defenderId] };

  // 战斗描述
  const skillDescriptions = {
    1: "使出独孤九剑，剑光如虹直刺对方要害！",
    2: "运起金钟罩，周身泛起金色罡气！",
    3: "脚踏凌波微步，身形飘忽难以捉摸！",
  };

  const attackActions = [
    /*...*/
  ];
  const dodgeActions = [
    /*...*/
  ];

  // 暴击和特效描述
  const criticalHits = [
    "🔥 会心一击！伤害翻倍！",
    "💫 招式精妙，直击破绽！",
    "🌟 气贯长虹，威力惊人！",
  ];

  const specialEffects = [
    "🌪️ 劲风四起，飞沙走石！",
    "💧 水滴飞溅，寒气逼人！",
    "⚡ 电光火石，瞬息万变！",
    "🌩️ 雷鸣电闪，声势骇人！",
  ];

  let round = 1;

  while (attacker.health > 0 && defender.health > 0 && round <= 20) {
    battleLog.push(`第${round}回合：`);

    // 特效描述
    if (Math.random() > 0.5) {
      battleLog.push(
        specialEffects[Math.floor(Math.random() * specialEffects.length)]
      );
    }

    // 攻击方使用技能
    if (attacker.activeSkill) {
      const skill = SKILLS[attacker.activeSkill];
      battleLog.push(`🗡️「${attacker.name}」${skillDescriptions[skill.id]}`);

      // 技能效果
      if (skill.damageMultiplier) {
        const damage = Math.max(
          1,
          Math.floor(
            attacker.attack * skill.damageMultiplier - defender.defense
          )
        );
        defender.health -= damage;
        battleLog.push(`💥 造成 ${damage} 点伤害！`);

        // 暴击描述
        if (damage > 15 && Math.random() > 0.7) {
          battleLog.push(
            criticalHits[Math.floor(Math.random() * criticalHits.length)]
          );
        }
      }

      // ...其他技能效果
    }
    // 普通攻击
    else {
      const action =
        attackActions[Math.floor(Math.random() * attackActions.length)];
      battleLog.push(`👊「${attacker.name}」${action}`);

      // 凌波微步闪避判定
      if (defender.activeSkill === 3) {
        battleLog.push(
          `🌀「${defender.name}」${
            dodgeActions[Math.floor(Math.random() * dodgeActions.length)]
          }`
        );
        const counterDmg = Math.max(
          1,
          Math.floor(defender.attack * 0.8 - attacker.defense)
        );
        attacker.health -= counterDmg;
        battleLog.push(`💥 反击造成 ${counterDmg} 点伤害！`);

        // 暴击描述
        if (counterDmg > 15 && Math.random() > 0.7) {
          battleLog.push(
            criticalHits[Math.floor(Math.random() * criticalHits.length)]
          );
        }

        defender.activeSkill = null;
      }
      // 普通伤害
      else {
        const damage = Math.max(
          1,
          Math.floor(
            attacker.attack -
              defender.defense * (defender.activeSkill === 2 ? 1.5 : 1)
          )
        );
        defender.health -= damage;
        battleLog.push(`💥 造成 ${damage} 点伤害！`);

        // 暴击描述
        if (damage > 15 && Math.random() > 0.7) {
          battleLog.push(
            criticalHits[Math.floor(Math.random() * criticalHits.length)]
          );
        }
      } // 添加这个闭合花括号
    } // 普通攻击分支结束

    // 交换攻守
    [attacker, defender] = [defender, attacker];
    [attackerId, defenderId] = [defenderId, attackerId];
    round++;
  } // while循环结束

  // 确定胜者
  if (attacker.health <= 0) {
    return {
      winner: defenderId,
      message: `🏆 胜利者：${users[defenderId].name}！`,
    };
  } else if (defender.health <= 0) {
    return {
      winner: attackerId,
      message: `🏆 胜利者：${users[attackerId].name}！`,
    };
  } else {
    return {
      winner: null,
      message: "⏱️ 战斗超时，双方平手！",
    };
  }
}

bot.onText(/^\/daily/, async (msg) => {
  try {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    const user = users[userId];
    const now = Date.now();
    const lastDaily = user.lastDaily || 0;

    // 检查是否已领取
    if (lastDaily && now - lastDaily < 24 * 60 * 60 * 1000) {
      const nextDaily = lastDaily + 24 * 60 * 60 * 1000;
      const hoursLeft = Math.ceil((nextDaily - now) / (60 * 60 * 1000));
      return await safeSendMessage(
        chatId,
        `今日奖励已领取，请 ${hoursLeft} 小时后再来！`
      );
    }

    // 发放随机奖励
    const goldReward = 200 + Math.floor(Math.random() * 300); // 200-500金币
    const expReward = 10 + Math.floor(Math.random() * 20); // 10-30经验

    user.gold += goldReward;
    addExp(userId, expReward);
    user.lastDaily = now;

    await saveData();

    await safeSendMessage(
      chatId,
      `🎁 每日奖励领取成功！\n\n💰 获得金币: +${goldReward}\n✨ 获得经验: +${expReward}`
    );
  } catch (error) {
    console.error("/daily命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/daily命令错误: ${error.message}`);
  }
});

// 2. 修炼与战斗命令
bot.onText(/^\/cultivate/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    const user = users[userId];
    const now = Date.now();

    if (user.lastXiuLianTime && now - user.lastXiuLianTime < 3600 * 1000) {
      const remainingTime = Math.ceil(
        (3600 * 1000 - (now - user.lastXiuLianTime)) / 60000
      );
      return await safeSendMessage(
        chatId,
        `你刚刚修炼过，还需要等待${remainingTime}分钟才能再次修炼。`
      );
    }

    // 修炼恢复血量和属性
    const recoverAmount = Math.floor(user.level * 0.1 * user.maxHealth);
    user.health = Math.min(user.health + recoverAmount, user.maxHealth);

    // 恢复灵力
    user.spirit = user.maxSpirit;

    // 增加经验
    addExp(userId, 5);

    // 更新修炼时间
    user.lastXiuLianTime = now;

    await saveData();

    await safeSendMessage(
      chatId,
      `「${user.name}」开始修炼...\n\n💪 修炼结束，恢复了${recoverAmount}点生命值！\n✨ 获得了5点经验值！`
    );
  } catch (error) {
    console.error("/cultivate命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/cultivate命令错误: ${error.message}`);
  }
});

// === 添加玩家PK命令 ===
bot.onText(/^\/pk (.+)/, async (msg, match) => {
  try {
    const targetUsername = match[1].replace("@", "");
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    // 查找目标玩家
    const targetUser = Object.values(users).find(
      (u) =>
        u.name.includes(targetUsername) || u.id.toString() === targetUsername
    );

    if (!targetUser) {
      return await safeSendMessage(chatId, `找不到玩家「${targetUsername}」！`);
    }

    if (userId === targetUser.id) {
      return await safeSendMessage(chatId, "不能和自己对战！");
    }
    console.log(userList); // 看看数组内容

    // 检查冷却时间（5分钟）
    const now = Date.now();
    if (
      users[userId].lastPkTime &&
      now - users[userId].lastPkTime < 5 * 60 * 1000
    ) {
      const cooldown = Math.ceil(
        (5 * 60 * 1000 - (now - users[userId].lastPkTime)) / 60000
      );
      return await safeSendMessage(
        chatId,
        `PK冷却中，请${cooldown}分钟后再战！`
      );
    }

    // 开始PK
    const battleLog = [];
    const result = await simulateBattle(userId, targetUser.id, battleLog);

    // 更新冷却时间
    users[userId].lastPkTime = now;
    users[targetUser.id].lastPkTime = now;

    // 发送战斗过程
    const battleText =
      "⚔️【武林对决】⚔️\n" +
      `「${users[userId].name}」 vs 「${targetUser.name}」\n\n` +
      battleLog.join("\n") +
      "\n\n" +
      result.message;

    await safeSendMessage(chatId, battleText);

    // 处理奖励/惩罚
    if (result.winner === userId) {
      await handlePkReward(userId, 100, 10, 10);
      addExp(targetUser.id, -10); // 失败者经验扣除
      await safeSendMessage(
        chatId,
        `🎉 胜者「${users[userId].name}」获得奖励：\n` +
          `💰 +100金币 | ✨ +10灵力 | 📈 +10经验\n` +
          `💔 败者「${targetUser.name}」损失10点经验`
      );
    } else if (result.winner === targetUser.id) {
      await handlePkReward(targetUser.id, 100, 10, 10);
      addExp(userId, -10);
      await safeSendMessage(
        chatId,
        `🎉 胜者「${targetUser.name}」获得奖励：\n` +
          `💰 +100金币 | ✨ +10灵力 | 📈 +10经验\n` +
          `💔 败者「${users[userId].name}」损失10点经验`
      );
    } else {
      await safeSendMessage(chatId, "平局！双方未获得奖励也未受惩罚");
    }

    await saveData();
  } catch (error) {
    console.error("/pk命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/pk命令错误: ${error.message}`);
  }
});

// PK奖励处理
async function handlePkReward(winnerId, gold, spirit, exp) {
  const user = users[winnerId];
  user.gold += gold;
  user.spirit = Math.min(user.maxSpirit, user.spirit + spirit);
  addExp(winnerId, exp);

  // 30%几率获得装备
  if (Math.random() < 0.3) {
    const equip = generateEquipment(user.level);
    user.inventory.push(equip);
    await safeSendMessage(
      winnerId,
      `🎁 获得战利品: ${equip.name}\n` +
        `⚔️ 攻击+${equip.attack} | 🛡️ 防御+${equip.defense}`
    );
  }
}

bot.onText(/^\/fight (.+)/, async (msg, match) => {
  try {
    const monsterId = match[1];
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    // 调用战斗处理函数
    await handleAttack(userId, monsterId, chatId);
  } catch (error) {
    console.error("/fight命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/fight命令错误: ${error.message}`);
  }
});

bot.onText(/^\/use (.+)/, async (msg, match) => {
  try {
    const skillName = match[1];
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    const user = users[userId];

    // 查找技能
    const skill = Object.values(SKILLS).find((s) => s.name === skillName);
    if (!skill) {
      return await safeSendMessage(chatId, "无效技能！");
    }

    // 检查是否已学习
    if (!user.skills.includes(skill.id)) {
      return await safeSendMessage(chatId, "尚未习得此武功！");
    }

    // 检查冷却
    if (user.skillCooldowns[skill.id] > Date.now()) {
      const remaining = Math.ceil(
        (user.skillCooldowns[skill.id] - Date.now()) / 60000
      );
      return await safeSendMessage(
        chatId,
        `此招式尚在调息中，还需${remaining}分钟`
      );
    }

    // 检查灵力
    if (user.spirit < skill.cost) {
      return await safeSendMessage(
        chatId,
        `内力不足，无法施展「${skill.name}」！`
      );
    }

    // 设置主动技能
    user.activeSkill = skill.id;
    user.skillCooldowns[skill.id] = Date.now() + skill.cooldown * 60 * 1000;

    await safeSendMessage(
      chatId,
      `⛩️ 已准备施展「${skill.name}」！下次攻击将使用此招式`
    );
  } catch (error) {
    console.error("/use命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/use命令错误: ${error.message}`);
  }
});

bot.onText(/^\/myskills/, async (msg) => {
  try {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    const user = users[userId];
    let skillsInfo = "📜 已学武功:\n\n";

    user.skills.forEach((skillId) => {
      const skill = SKILLS[skillId];
      if (skill) {
        skillsInfo += `🔹 ${skill.name} - ${skill.description}\n`;
        skillsInfo += `   消耗内力: ${skill.cost} | `;

        if (user.skillCooldowns[skillId] > Date.now()) {
          const remaining = Math.ceil(
            (user.skillCooldowns[skillId] - Date.now()) / 60000
          );
          skillsInfo += `冷却中: ${remaining}分钟\n\n`;
        } else {
          skillsInfo += `可用\n\n`;
        }
      }
    });

    if (user.skills.length === 0) {
      skillsInfo = "你尚未学习任何武功技能！";
    }

    await safeSendMessage(chatId, skillsInfo);
  } catch (error) {
    console.error("/myskills命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/myskills命令错误: ${error.message}`);
  }
});

// 3. 组队系统命令
bot.onText(/^\/invite (.+)/, async (msg, match) => {
  try {
    const targetUsername = match[1];
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    // TODO: 实现组队邀请逻辑
    await safeSendMessage(chatId, `已向 ${targetUsername} 发送组队邀请！`);
  } catch (error) {
    console.error("/invite命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/invite命令错误: ${error.message}`);
  }
});

bot.onText(/^\/accept/, async (msg) => {
  try {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    // TODO: 实现接受组队逻辑
    await safeSendMessage(chatId, `已接受组队邀请！`);
  } catch (error) {
    console.error("/accept命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/accept命令错误: ${error.message}`);
  }
});

bot.onText(/^\/leave/, async (msg) => {
  try {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    // TODO: 实现离开队伍逻辑
    await safeSendMessage(chatId, `已离开队伍！`);
  } catch (error) {
    console.error("/leave命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/leave命令错误: ${error.message}`);
  }
});

bot.onText(/^\/party/, async (msg) => {
  try {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    // TODO: 实现队伍信息逻辑
    await safeSendMessage(chatId, `队伍信息: 当前未加入任何队伍`);
  } catch (error) {
    console.error("/party命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/party命令错误: ${error.message}`);
  }
});

// 4. 门派系统命令
bot.onText(/^\/createclan (.+)/, async (msg, match) => {
  try {
    const clanName = match[1];
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    // 1. 验证用户是否已创建角色
    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    const user = users[userId];

    // 2. 验证用户是否已有门派
    if (user.门派) {
      return await safeSendMessage(chatId, "你已有门派，请先退出当前门派！");
    }

    // 3. 验证等级要求（66级）
    if (user.level < 66) {
      return await safeSendMessage(
        chatId,
        `创建门派需要达到66级！你当前等级：${user.level}`
      );
    }

    // 4. 验证金币要求（5000金币）
    if (user.gold < 5000) {
      return await safeSendMessage(
        chatId,
        `创建门派需要5000金币！你当前金币：${user.gold}`
      );
    }

    // 5. 验证门派名称长度
    if (clanName.length < 2 || clanName.length > 20) {
      return await safeSendMessage(chatId, "门派名称需在2-20个字符之间！");
    }

    // 6. 验证门派名称唯一性
    const existingClan = Object.values(clans).find(
      (clan) => clan.name === clanName
    );
    clans[newClan.id] = newClan;
    if (existingClan) {
      return await safeSendMessage(chatId, `门派名称【${clanName}】已被使用！`);
    }

    // 创建新门派
    const new门派 = {
      id: `门派_${Date.now()}`,
      name: clanName,
      level: 1,
      members: [userId],
      leader: userId,
      treasury: 0,
      reputation: 0,
      skills: [],
      created: Date.now(),
    };

    // 扣除创建费用
    user.gold -= 5000;

    // 更新用户信息
    user.门派 = new门派.id;
    user.职务 = "掌门";

    // 保存数据
    await saveData();

    await safeSendMessage(chatId, `🎉 恭喜成立新门派【${clanName}】！`);
    await safeSendMessage(chatId, `✅ 消耗5000金币\n✅ 你已成为门派掌门！`);
  } catch (error) {
    console.error("/createclan命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/createclan命令错误: ${error.message}`);
  }
});

// 修改 /joinclan 命令
bot.onText(/^\/joinclan (.+)/, async (msg, match) => {
  try {
    const clanId = match[1];
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    if (users[userId].门派) {
      return await safeSendMessage(chatId, "你已有门派，请先退出当前门派！");
    }

    if (!clans[clanId]) {
      return await safeSendMessage(chatId, "该门派不存在或ID错误！");
    }

    clans[clanId].members.push(userId);
    users[userId].门派 = clanId;
    users[userId].职务 = "普通弟子";

    await saveData();
    await safeSendMessage(chatId, `🎉 恭喜加入门派【${clans[clanId].name}】！`);
  } catch (error) {
    console.error("/joinclan命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/joinclan命令错误: ${error.message}`);
  }
});

// 添加在门派命令处理部分
bot.onText(/^\/clan_pk (.+)/, async (msg, match) => {
  try {
    const targetClanId = match[1];
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    const userClanId = users[userId].门派;
    if (!userClanId) {
      return await safeSendMessage(chatId, "请先加入门派！");
    }

    if (!clans[userClanId]) {
      return await safeSendMessage(chatId, "你的门派不存在！");
    }

    if (!clans[targetClanId]) {
      return await safeSendMessage(chatId, "目标门派不存在！");
    }

    // 检查冷却时间（1小时）
    const now = Date.now();
    if (
      clans[userClanId].lastPkTime &&
      now - clans[userClanId].lastPkTime < 60 * 60 * 1000
    ) {
      const cooldown = Math.ceil(
        (60 * 60 * 1000 - (now - clans[userClanId].lastPkTime)) / 60000
      );
      return await safeSendMessage(
        chatId,
        `门派PK冷却中，请${cooldown}分钟后再战！`
      );
    }

    // 更新冷却时间
    clans[userClanId].lastPkTime = now;
    clans[targetClanId].lastPkTime = now;

    // 选择参战成员（每方3人）
    const clan1Members = clans[userClanId].members
      .filter((id) => users[id])
      .sort((a, b) => users[b].level - users[a].level)
      .slice(0, 3);

    const clan2Members = clans[targetClanId].members
      .filter((id) => users[id])
      .sort((a, b) => users[b].level - users[a].level)
      .slice(0, 3);

    if (clan1Members.length < 1 || clan2Members.length < 1) {
      return await safeSendMessage(chatId, "参战成员不足！");
    }

    // 开始门派战
    let battleLog = [];
    let clan1Wins = 0;
    let clan2Wins = 0;

    battleLog.push(
      `🏯【门派大战】🏯\n` +
        `「${clans[userClanId].name}」 vs 「${clans[targetClanId].name}」\n`
    );

    // 进行3场1v1
    for (let i = 0; i < 3; i++) {
      const player1 = clan1Members[i % clan1Members.length];
      const player2 = clan2Members[i % clan2Members.length];

      if (!player1 || !player2) continue;

      battleLog.push(
        `\n⚔️ 第${i + 1}场：${users[player1].name} vs ${users[player2].name}`
      );

      const result = await simulateBattle(player1, player2, battleLog);

      if (result.winner === player1) {
        clan1Wins++;
        battleLog.push(`🏆 胜者：${users[player1].name}`);
      } else if (result.winner === player2) {
        clan2Wins++;
        battleLog.push(`🏆 胜者：${users[player2].name}`);
      } else {
        battleLog.push("平局！");
      }
    }

    // 确定胜方
    let winnerClanId = null;
    if (clan1Wins > clan2Wins) {
      winnerClanId = userClanId;
      battleLog.push(`\n🎉 最终胜利：${clans[userClanId].name}！`);
    } else if (clan2Wins > clan1Wins) {
      winnerClanId = targetClanId;
      battleLog.push(`\n🎉 最终胜利：${clans[targetClanId].name}！`);
    } else {
      battleLog.push("\n⚖️ 门派大战以平局收场！");
    }

    // 发送战斗日志
    await safeSendMessage(chatId, battleLog.join("\n"));

    // 发放奖励
    if (winnerClanId) {
      const winnerClan = clans[winnerClanId];
      const loserClanId =
        winnerClanId === userClanId ? targetClanId : userClanId;

      // 胜者奖励
      winnerClan.members.forEach(async (memberId) => {
        if (users[memberId]) {
          users[memberId].gold += 200;
          users[memberId].spirit = Math.min(
            users[memberId].maxSpirit,
            users[memberId].spirit + 10
          );
          addExp(memberId, 20);

          // 40%几率获得装备
          if (Math.random() < 0.4) {
            const equip = generateEquipment(users[memberId].level);
            users[memberId].inventory.push(equip);
            await safeSendMessage(
              memberId,
              `🎁 门派胜利奖励: ${equip.name}\n` +
                `💰 +200金币 | ✨ +10灵力 | 📈 +20经验`
            );
          }
        }
      });

      // 败者惩罚
      clans[loserClanId].members.forEach((memberId) => {
        if (users[memberId]) {
          addExp(memberId, -10);
        }
      });

      await safeSendMessage(
        chatId,
        `🎉 胜者门派「${winnerClan.name}」成员获得：\n` +
          `💰 200金币 | ✨ 10灵力 | 📈 20经验\n` +
          `💔 败者门派成员损失10点经验`
      );
    }

    await saveData();
  } catch (error) {
    console.error("/clan_pk命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/clan_pk命令错误: ${error.message}`);
  }
});

// === 添加门派PK命令 ===
bot.onText(/^\/clan_pk (.+)/, async (msg, match) => {
  try {
    const targetClanId = match[1];
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    const userClanId = users[userId].门派;
    if (!userClanId) {
      return await safeSendMessage(chatId, "请先加入门派！");
    }

    if (!clans[userClanId]) {
      return await safeSendMessage(chatId, "你的门派不存在！");
    }

    if (!clans[targetClanId]) {
      return await safeSendMessage(chatId, "目标门派不存在！");
    }

    // 检查冷却时间（1小时）
    const now = Date.now();
    if (
      clans[userClanId].lastPkTime &&
      now - clans[userClanId].lastPkTime < 60 * 60 * 1000
    ) {
      const cooldown = Math.ceil(
        (60 * 60 * 1000 - (now - clans[userClanId].lastPkTime)) / 60000
      );
      return await safeSendMessage(
        chatId,
        `门派PK冷却中，请${cooldown}分钟后再战！`
      );
    }

    // 更新冷却时间
    clans[userClanId].lastPkTime = now;
    clans[targetClanId].lastPkTime = now;

    // 选择参战成员（每方3人）
    const clan1Members = clans[userClanId].members
      .filter((id) => users[id])
      .sort((a, b) => users[b].level - users[a].level)
      .slice(0, 3);

    const clan2Members = clans[targetClanId].members
      .filter((id) => users[id])
      .sort((a, b) => users[b].level - users[a].level)
      .slice(0, 3);

    if (clan1Members.length < 1 || clan2Members.length < 1) {
      return await safeSendMessage(chatId, "参战成员不足！");
    }

    // 开始门派战
    let battleLog = [];
    let clan1Wins = 0;
    let clan2Wins = 0;

    battleLog.push(
      `🏯【门派大战】🏯\n` +
        `「${clans[userClanId].name}」 vs 「${clans[targetClanId].name}」\n`
    );

    // 进行3场1v1
    for (let i = 0; i < 3; i++) {
      const player1 = clan1Members[i % clan1Members.length];
      const player2 = clan2Members[i % clan2Members.length];

      if (!player1 || !player2) continue;

      battleLog.push(
        `\n⚔️ 第${i + 1}场：${users[player1].name} vs ${users[player2].name}`
      );

      const result = await simulateBattle(player1, player2, battleLog);

      if (result.winner === player1) {
        clan1Wins++;
        battleLog.push(`🏆 胜者：${users[player1].name}`);
      } else if (result.winner === player2) {
        clan2Wins++;
        battleLog.push(`🏆 胜者：${users[player2].name}`);
      } else {
        battleLog.push("平局！");
      }
    }

    // 确定胜方
    let winnerClanId = null;
    if (clan1Wins > clan2Wins) {
      winnerClanId = userClanId;
      battleLog.push(`\n🎉 最终胜利：${clans[userClanId].name}！`);
    } else if (clan2Wins > clan1Wins) {
      winnerClanId = targetClanId;
      battleLog.push(`\n🎉 最终胜利：${clans[targetClanId].name}！`);
    } else {
      battleLog.push("\n⚖️ 门派大战以平局收场！");
    }

    // 发送战斗日志
    await safeSendMessage(chatId, battleLog.join("\n"));

    // 发放奖励
    if (winnerClanId) {
      const winnerClan = clans[winnerClanId];
      const loserClanId =
        winnerClanId === userClanId ? targetClanId : userClanId;

      // 胜者奖励
      winnerClan.members.forEach(async (memberId) => {
        if (users[memberId]) {
          users[memberId].gold += 200;
          users[memberId].spirit = Math.min(
            users[memberId].maxSpirit,
            users[memberId].spirit + 10
          );
          addExp(memberId, 20);

          // 40%几率获得装备
          if (Math.random() < 0.4) {
            const equip = generateEquipment(users[memberId].level);
            users[memberId].inventory.push(equip);
            await safeSendMessage(
              memberId,
              `🎁 门派胜利奖励: ${equip.name}\n` +
                `💰 +200金币 | ✨ +10灵力 | 📈 +20经验`
            );
          }
        }
      });

      // 败者惩罚
      clans[loserClanId].members.forEach((memberId) => {
        if (users[memberId]) {
          addExp(memberId, -10);
        }
      });

      await safeSendMessage(
        chatId,
        `🎉 胜者门派「${winnerClan.name}」成员获得：\n` +
          `💰 200金币 | ✨ 10灵力 | 📈 20经验\n` +
          `💔 败者门派成员损失10点经验`
      );
    }

    await saveData();
  } catch (error) {
    console.error("/clan_pk命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/clan_pk命令错误: ${error.message}`);
  }
});

// 修改 /leaveclan 命令
bot.onText(/^\/leaveclan/, async (msg) => {
  try {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (!users[userId]) {
      return await safeSendMessage(chatId, "请先使用 /start 创建角色！");
    }

    if (!users[userId].门派) {
      return await safeSendMessage(chatId, "你当前没有加入任何门派！");
    }

    const clanId = users[userId].门派;
    // 从门派成员中移除
    const index = clans[clanId].members.indexOf(userId);
    if (index > -1) {
      clans[clanId].members.splice(index, 1);
    }

    // 清除用户门派信息
    users[userId].门派 = null;
    users[userId].职务 = "无门派";

    await saveData();
    await safeSendMessage(chatId, `已退出门派【${clans[clanId].name}】！`);
  } catch (error) {
    console.error("/leaveclan命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/leaveclan命令错误: ${error.message}`);
  }
});

// 修改 /clans 命令
bot.onText(/^\/clans/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    let clanList = "🏯 门派列表:\n\n";

    Object.values(clans).forEach((clan) => {
      clanList += `🔹 ${clan.name} (ID: ${clan.id})\n`;
      clanList += `   成员: ${clan.members.length}人\n`;
      clanList += `   掌门: ${users[clan.leader]?.name || "未知"}\n\n`;
    });

    if (Object.keys(clans).length === 0) {
      clanList = "当前没有任何门派，使用 /createclan 创建第一个门派吧！";
    }

    await safeSendMessage(chatId, clanList);
  } catch (error) {
    console.error("/clans命令错误:", error);
    await safeSendMessage(ADMIN_ID, `/clans命令错误: ${error.message}`);
  }
});

// 5. 管理员命令
bot.onText(/^\/admin/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (userId !== ADMIN_ID) {
      return await safeSendMessage(chatId, "你不是管理员，无权使用此命令！");
    }

    const command = msg.text.split(" ")[1];

    switch (command) {
      case "boos":
        globalConfig.invincibleMode = true;
        await safeSendMessage(chatId, "已开启无敌模式！");
        break;
      case "sss":
        globalConfig.invincibleMode = false;
        await safeSendMessage(chatId, "已关闭无敌模式，恢复普通模式！");
        break;
      default:
        await safeSendMessage(
          chatId,
          "可用命令: /admin boos (无敌模式) /admin sss (普通模式)"
        );
    }
  } catch (error) {
    console.error("管理员命令错误:", error);
    await safeSendMessage(ADMIN_ID, `管理员命令错误: ${error.message}`);
  }
});

// ===========================
// 辅助函数部分
// ===========================
function createNewUser(from) {
  // 初始化所有技能冷却时间为0
  const skillCooldowns = {};
  for (const skillId in SKILLS) {
    skillCooldowns[skillId] = 0;
  }

  return {
    id: from.id,
    name: from.first_name || `江湖过客${Math.floor(Math.random() * 1000)}`,
    level: 1,
    exp: 0,
    expToNextLevel: 100,
    health: 100,
    maxHealth: 100,
    spirit: 100,
    maxSpirit: 100,
    attack: 10,
    defense: 5,
    speed: 10,
    gold: 100,
    门派: null,
    职务: "普通弟子",
    equip: {
      weapon: null,
      armor: null,
      helmet: null,
      boots: null,
      accessory: null,
    },
    inventory: [],
    lastXiuLianTime: 0,
    lastMessageTime: Date.now(),
    messageCount: 0,
    createdTime: Date.now(),
    pkWins: 0,
    pkLosses: 0,
    monsterKills: 0,
    boosKills: 0,
    江湖排名: 0,
    称号: "初入江湖",
    skills: [1], // 默认技能
    activeSkill: null, // 当前准备使用的技能
    skillCooldowns: {}, // 技能冷却时间记录
    equipSetCount: { weapon: 0, armor: 0, helmet: 0, boots: 0, accessory: 0 },
    partyMembers: [], // 队伍成员
    lastDaily: 0, // 每日奖励领取时间
  };
}

function addExp(userId, amount) {
  const user = users[userId];
  if (!user) return;

  user.exp += amount;

  // 检查是否升级
  while (user.exp >= user.expToNextLevel) {
    user.exp -= user.expToNextLevel;
    user.level++;
    user.expToNextLevel = Math.floor(user.expToNextLevel * 1.5);

    // 升级属性提升
    user.maxHealth += 20;
    user.health = user.maxHealth;
    user.maxSpirit += 10;
    user.spirit = user.maxSpirit;
    user.attack += 5;
    user.defense += 3;
    user.speed += 1;

    // 更新江湖称号
    updateTitle(user);

    safeSendMessage(
      userId,
      `🎉 恭喜「${user.name}」升级到${user.level}级！\n\n生命值+20\n灵力+10\n攻击+5\n防御+3\n速度+1`
    ).catch(console.error);
  }

  // 保存数据
  saveData().catch(console.error);
}

function updateTitle(user) {
  const titles = [
    "初入江湖",
    "江湖新秀",
    "武林少侠",
    "江湖豪杰",
    "武林高手",
    "一派掌门",
    "江湖大侠",
    "武林宗师",
    "绝世高手",
    "江湖传奇",
    "武林神话",
  ];

  const titleIndex = Math.min(Math.floor(user.level / 20), titles.length - 1);
  user.称号 = titles[titleIndex];
}

function generateProfileText(user) {
  let profile = `「${user.name}」 - ${user.称号}\n`;
  profile += `🏅 等级: ${user.level} (${user.exp}/${user.expToNextLevel}经验)\n`;
  profile += `❤️ 生命: ${user.health}/${user.maxHealth}\n`;
  profile += `✨ 灵力: ${user.spirit}/${user.maxSpirit}\n`;
  profile += `⚔️ 攻击: ${user.attack}\n`;
  profile += `🛡️ 防御: ${user.defense}\n`;
  profile += `💨 速度: ${user.speed}\n`;
  profile += `💰 金币: ${user.gold}\n\n`;

  profile += `📊 战绩\n`;
  profile += `   击败怪物: ${user.monsterKills}\n`;
  profile += `   击败BOSS: ${user.boosKills}\n`;
  profile += `   PK胜场: ${user.pkWins}\n`;
  profile += `   PK败场: ${user.pkLosses}\n\n`;

  if (user.门派) {
    profile += `🏫 门派: ${user.门派} (${user.职务})\n`;
  }

  // 添加门派创建条件提示
  if (!user.门派 && user.level < 66) {
    profile += `\nℹ️ 创建门派需要达到66级（当前：${user.level}级）`;
  }

  if (!user.门派 && user.level >= 66 && user.gold < 5000) {
    profile += `\nℹ️ 创建门派需要5000金币（当前：${user.gold}金币）`;
  }

  // 显示技能信息
  if (user.skills && user.skills.length > 0) {
    profile += `\n🎯 武功技能:\n`;
    user.skills.forEach((skillId) => {
      const skill = SKILLS[skillId];
      if (skill) {
        profile += `  - ${skill.name}: ${skill.description}\n`;
      }
    });
  }

  return profile;
}

function createNewUser(from) {
  return {
    // ...其他属性
    lastPkTime: 0, // 上次PK时间
    pkStreak: 0, // 连胜次数
    // ...其他属性
  };
}

async function saveData() {
  try {
    const data = {
      users,
      groups,
      clans: clans,
      globalConfig,
    };

    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("保存数据错误:", error);
    await safeSendMessage(ADMIN_ID, `保存数据错误: ${error.message}`);
  }
}

// 装备生成函数
function generateEquipment(monsterLevel) {
  const type = EQUIP_TYPES[Math.floor(Math.random() * EQUIP_TYPES.length)];
  const rarity = Math.min(4, Math.floor(monsterLevel / 5)); // 根据怪物等级确定品质
  const baseStat = Math.floor(monsterLevel * (1 + rarity * 0.5)); // 基础属性值

  return {
    id: `equip_${Date.now()}`,
    name: `${EQUIP_RARITY[rarity]}${getEquipTypeName(type)}`,
    type,
    rarity,
    attack: type === "weapon" ? baseStat : 0,
    defense: type !== "weapon" ? baseStat : 0,
    levelRequirement: monsterLevel,
  };
}

// 新增装备类型名称映射
function getEquipTypeName(type) {
  const names = {
    weapon: "武器",
    armor: "护甲",
    helmet: "头盔",
    boots: "靴子",
    accessory: "饰品",
  };
  return names[type] || "装备";
}

// 怪物系统
function spawnRandomMonster() {
  // 添加速率限制检查
  const now = Date.now();
  if (now - globalConfig.lastMonsterSpawn < 60 * 1000) {
    // 至少间隔 1 分钟
    return;
  }

  globalConfig.lastMonsterSpawn = now;
  // 随机选择一个群组
  const groupIds = Object.keys(groups);
  if (groupIds.length === 0) return;

  const randomGroupId = groupIds[Math.floor(Math.random() * groupIds.length)];

  // 生成随机怪物
  const monsterTypes = [
    {
      name: "小喽啰",
      level: 1,
      health: 50,
      attack: 5,
      defense: 2,
      gold: [5, 15],
      exp: 10,
    },
    {
      name: "山贼",
      level: 3,
      health: 100,
      attack: 10,
      defense: 5,
      gold: [10, 25],
      exp: 20,
    },
    {
      name: "恶霸",
      level: 5,
      health: 200,
      attack: 15,
      defense: 8,
      gold: [20, 40],
      exp: 30,
    },
    {
      name: "武林败类",
      level: 8,
      health: 350,
      attack: 25,
      defense: 12,
      gold: [30, 50],
      exp: 50,
    },
    {
      name: "魔教弟子",
      level: 12,
      health: 500,
      attack: 35,
      defense: 18,
      gold: [40, 60],
      exp: 70,
    },
    {
      name: "江湖大盗",
      level: 15,
      health: 700,
      attack: 45,
      defense: 25,
      gold: [50, 80],
      exp: 100,
    },
  ];

  const randomMonster =
    monsterTypes[Math.floor(Math.random() * monsterTypes.length)];

  // 随机调整怪物属性
  const monsterLevel = Math.floor(Math.random() * 5) + randomMonster.level;
  const monster = {
    id: `monster_${Date.now()}`,
    name: randomMonster.name,
    level: monsterLevel,
    health: randomMonster.health * (monsterLevel / randomMonster.level),
    maxHealth: randomMonster.health * (monsterLevel / randomMonster.level),
    attack: randomMonster.attack * (monsterLevel / randomMonster.level),
    defense: randomMonster.defense * (monsterLevel / randomMonster.level),
    gold: [
      Math.floor(randomMonster.gold[0] * (monsterLevel / randomMonster.level)),
      Math.floor(randomMonster.gold[1] * (monsterLevel / randomMonster.level)),
    ],
    exp: randomMonster.exp * (monsterLevel / randomMonster.level),
    groupId: randomGroupId,
    spawnTime: Date.now(),
  };

  monsters[monster.id] = monster;

  // 发送消息到群组
  safeSendMessage(
    randomGroupId,
    `⚠️ 注意！发现${monster.name}（Lv.${monster.level}）！\n\n生命值: ${monster.health}/${monster.maxHealth}\n攻击力: ${monster.attack}\n防御力: ${monster.defense}\n\n使用 /attack ${monster.id} 攻击！`
  );

  // 3分钟后怪物消失
  setTimeout(() => {
    if (monsters[monster.id]) {
      delete monsters[monster.id];
      safeSendMessage(
        randomGroupId,
        `👻 ${monster.name}（Lv.${monster.level}）已经逃走了！`
      );
    }
  }, 180000);
}

// 启动机器人
init();
