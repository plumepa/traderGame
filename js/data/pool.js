/**
 * 行业表与股票池
 *
 * 为什么是 .js 而不是 .json？
 * 微信小游戏的打包器不支持 import JSON —— 它会把路径当模块名
 * 自动补 .js 后缀，去找 "xxx.json.js" 从而报错。
 * 因此数据一律以 .js 模块形式导出。
 *
 * ============ 第四版：全部改用**虚构**公司与代码 ============
 *
 * 需求原话：「股票名称，股票代码可以换成不存在的，避免不必要的麻烦」。
 *
 * 旧版直接用真实上市公司（贵州茅台 600519、工商银行 601398 …），
 * 存在两个问题：
 *   ① 把真实公司放进"会退市/会爆雷"的游戏叙事里，是不必要的风险；
 *   ② 真实代码会诱导玩家用现实记忆去玩（"茅台肯定涨"），
 *      而这游戏的乐趣恰恰是**只能看盘面、不能看招牌**。
 *
 * 因此这里所有公司名与代码均为杜撰。代码沿用 A 股样式（6 位数字）
 * 以保持真实感，但**刻意避开真实占用号段**：
 *   虚构代码统一使用 `9` 开头的 6 位号（900xxx / 909xxx / 990xxx），
 *   与真实 A 股（600/601/603/000/002/300 开头）不会撞车。
 *
 * ============ 设计约束（不要为了好看而破坏）============
 *
 * 1. ⚠️「股价」不能成为可被利用的选股信号。
 *
 *    这条约束我前后写错了两版，把踩坑过程留在这里，免得后人再踩：
 *
 *    【第一版】"basePrice 与 trend 的相关系数必须接近 0"。
 *      → 错的。相关系数管不住这件事：大公司天然贵、小公司天然便宜，
 *        价格分档本身就产生相关。我写了个优化器去压这个系数，
 *        结果它把地产股抬到 28 元、电力股压到 4 元 —— 定价彻底失真。
 *        而且当时我甚至弄错了变量（动的是 luck，量的却是 trend）。
 *
 *    【第二版】"'买最贵'的收益优势必须 < 0.5%/年"。
 *      → 门槛是拍脑袋定的，没有统计依据。后来发现 1.4% 的优势
 *        随抽样上下浮动，用固定门槛必然时好时坏。
 *
 *    【现在】用**置换检验**（tools/diag-pool.mjs）：
 *      把 34 个价签随机重排 40 次，得到"纯随机定价下的优势分布"，
 *      再看真实定价落在这个分布的哪里。
 *      实测：真实优势 1.4%，随机分布 [-7.3%, +5.9%]，真实值第 63 百分位
 *      → **与随机定价无统计区别**，说明股价里没有藏着可利用的信息。
 *
 *    ✅ 结论：改完价格请跑 `tools/diag-pool.mjs`。
 *       **不要**再去调相关系数，那是错的度量。
 *
 *    另外，本次重构确实修掉了一处真实缺陷：早先高价股（赤河酒业、
 *    启辰新能、瑞和银行、本草堂）恰好全部 luck 为正，而最便宜的三只
 *    恰好 luck 全负 —— 那才是"买贵占便宜"的真正来源。现在 luck 与
 *    价格已脱钩（corr ≈ 0.23，落在随机区间内）。
 *
 * 2. 行业数要够多。每局从"某个年景"里拿 3 只不同行业的股票，
 *    20 个年景 × 3 只 = 60 个坑位，需要足够多的行业来分散。
 *    当前 12 个行业：10 个行业各 3 只，农业与传媒各 2 只。
 *
 * 3. profile.luck 为负的股票才有退市风险，这是"爆雷"叙事的来源。
 *    每个行业里至少要有 1 只 luck 明显为负的股票，
 *    否则熊市里"会退市"的玩法就落空了（见 pathgen.rollDelist）。
 *
 * 4. 价格跨度要留够（当前 5 元 ~ 34 元，价差比 ≈ 6.8）。
 *    价差太窄会让"每个年景都买得起合理手数"的平衡约束失效
 *    （见 selftest [9] 的数值平衡段）。
 */

// ============ 行业大类（新闻按此匹配）============
export const SECTORS = {
  liquor: '白酒',
  realestate: '地产',
  newenergy: '新能源',
  energy: '能源',
  tech: '科技',
  transport: '运输',
  finance: '金融',
  pharma: '医药',
  consumer: '消费',
  materials: '材料',
  agriculture: '农业',
  media: '传媒',
};

// ============ 股票池 ============
// code 为展示用代码（虚构）；profile 决定"性格"
//   trend : -0.8 强空 ~ +0.8 强多（牛市里顺势放大、熊市里逆势压缩）
//   vol   : 波动强度（0~2），越大月度振幅越夸张
//   luck  : 命运倾向（-1 易爆雷 / +1 易走强），影响极端事件与退市概率
//
// ⚠️ 见文件头"设计约束 1"：价格不要做成可被利用的信号。
//    改完价格必须跑 tools/diag-pool.mjs 的行为检验。
export const STOCK_POOL = [
  // ---------- 白酒 liquor ----------
  {
    code: '900101', name: '赤河酒业', sector: 'liquor',
    basePrice: 28, floor: 8,
    profile: { trend: 0.55, vol: 0.8, luck: 0.5 },
    personality: '稳健白马：慢涨慢跌，回撤温和',
  },
  {
    code: '900102', name: '云岭老窖', sector: 'liquor',
    basePrice: 17, floor: 5,
    profile: { trend: 0.3, vol: 1.4, luck: -0.45 },
    personality: '二线酒企：品牌力不足，靠渠道压货冲业绩',
  },
  {
    code: '900103', name: '金沙春酒', sector: 'liquor',
    basePrice: 6, floor: 2,
    profile: { trend: 0.45, vol: 1.7, luck: 0.1 },
    personality: '区域小酒：弹性极大，题材一来就连板',
  },

  // ---------- 地产 realestate ----------
  {
    code: '900201', name: '宏图地产', sector: 'realestate',
    basePrice: 9, floor: 3,
    profile: { trend: 0.2, vol: 1.3, luck: -0.7 },
    personality: '高杠杆地产：牛市跟涨、熊市率先爆雷',
  },
  {
    code: '900202', name: '恒泰置业', sector: 'realestate',
    basePrice: 6, floor: 2,
    profile: { trend: -0.3, vol: 1.6, luck: -0.85 },
    personality: '出险房企：债务压顶，任何风吹草动都可能是最后一根稻草',
  },
  {
    code: '900203', name: '锦城控股', sector: 'realestate',
    basePrice: 13, floor: 4,
    profile: { trend: 0.15, vol: 0.9, luck: 0.35 },
    personality: '稳健房企：低负债、现金流好，跌得也比同行少',
  },

  // ---------- 新能源 newenergy ----------
  {
    code: '900301', name: '启辰新能', sector: 'newenergy',
    basePrice: 22, floor: 7,
    profile: { trend: 0.6, vol: 1.6, luck: 0.3 },
    personality: '高波动成长：大起大落，题材驱动',
  },
  {
    code: '900302', name: '聚光电池', sector: 'newenergy',
    basePrice: 19, floor: 6,
    profile: { trend: 0.35, vol: 1.8, luck: -0.5 },
    personality: '二线电池厂：产能扩张激进，价格战里最先受伤',
  },
  {
    code: '900303', name: '风光电力', sector: 'newenergy',
    basePrice: 11, floor: 3,
    profile: { trend: 0.25, vol: 0.8, luck: 0.4 },
    personality: '绿电运营：补贴与电价双稳，成长慢但抗跌',
  },

  // ---------- 能源 energy ----------
  {
    code: '900401', name: '寰宇石油', sector: 'energy',
    basePrice: 10, floor: 3,
    profile: { trend: -0.1, vol: 0.9, luck: -0.2 },
    personality: '周期能源：油价一涨就亢奋，跌起来也毫不留情',
  },
  {
    code: '900402', name: '恒源炼化', sector: 'energy',
    basePrice: 8, floor: 2,
    profile: { trend: 0.05, vol: 0.7, luck: 0.1 },
    personality: '炼化巨头：波动小、股息厚，熊市里的"类债券"',
  },
  {
    code: '900403', name: '蓝焰燃气', sector: 'energy',
    basePrice: 10, floor: 3,
    profile: { trend: 0.2, vol: 0.6, luck: 0.45 },
    personality: '城市燃气：特许经营权护身，需求刚性',
  },

  // ---------- 科技 tech ----------
  {
    code: '900501', name: '目远智能', sector: 'tech',
    basePrice: 34, floor: 10,
    profile: { trend: 0.35, vol: 1.2, luck: 0.1 },
    personality: '科技龙头：估值高、弹性大，情绪来了连拉涨停',
  },
  {
    code: '900502', name: '讯捷通信', sector: 'tech',
    basePrice: 11, floor: 3,
    profile: { trend: 0.3, vol: 1.5, luck: -0.4 },
    personality: '通信设备：波动剧烈，一有出口管制传闻就跳水',
  },
  {
    code: '900503', name: '致远软件', sector: 'tech',
    basePrice: 20, floor: 6,
    profile: { trend: 0.5, vol: 1.3, luck: -0.15 },
    personality: '信创软件：订单靠政策节奏，回款慢、估值敏感',
  },

  // ---------- 运输 transport ----------
  {
    code: '900601', name: '陆港铁路', sector: 'transport',
    basePrice: 7, floor: 2,
    profile: { trend: 0.15, vol: 0.5, luck: 0.3 },
    personality: '陆运动脉：主营铁路货运，运量稳定、涨幅温和',
  },
  {
    code: '900602', name: '东望港务', sector: 'transport',
    basePrice: 6, floor: 2,
    profile: { trend: 0.2, vol: 0.9, luck: 0.1 },
    personality: '港口水运：吞吐量跟着外贸走，最怕关税消息',
  },
  {
    code: '900603', name: '远洋航运', sector: 'transport',
    basePrice: 9, floor: 3,
    profile: { trend: 0.4, vol: 1.7, luck: -0.35 },
    personality: '远洋航运：运价一涨就翻倍，一跌就巨亏，纯周期',
  },

  // ---------- 金融 finance ----------
  {
    code: '900701', name: '华信银行', sector: 'finance',
    basePrice: 6, floor: 2,
    profile: { trend: 0.1, vol: 0.4, luck: 0.4 },
    personality: '银行巨无霸：稳如老狗，涨跌都慢半拍',
  },
  {
    code: '900702', name: '瑞和银行', sector: 'finance',
    basePrice: 32, floor: 10,
    profile: { trend: 0.2, vol: 0.8, luck: 0.2 },
    personality: '零售银行标杆：高股价但涨得慢，牛市里容易踏空',
  },
  {
    code: '900703', name: '鼎盛证券', sector: 'finance',
    basePrice: 14, floor: 4,
    profile: { trend: 0.55, vol: 1.8, luck: -0.3 },
    personality: '券商：牛市的旗手、熊市的弃儿，自带 2 倍杠杆属性',
  },

  // ---------- 医药 pharma ----------
  {
    code: '900801', name: '康泽制药', sector: 'pharma',
    basePrice: 16, floor: 5,
    profile: { trend: 0.45, vol: 1.0, luck: 0.1 },
    personality: '创新药龙头：研发管线催化，集采消息是最大变量',
  },
  {
    code: '900802', name: '本草堂', sector: 'pharma',
    basePrice: 26, floor: 8,
    profile: { trend: 0.1, vol: 0.6, luck: 0.3 },
    personality: '消费医药：品牌护城河深，防御属性强，但涨得慢',
  },
  {
    code: '900803', name: '普济生物', sector: 'pharma',
    basePrice: 11, floor: 3,
    profile: { trend: 0.2, vol: 1.9, luck: -0.6 },
    personality: '单一管线药企：成也临床、败也临床，消息即生死',
  },

  // ---------- 消费 consumer ----------
  {
    code: '900901', name: '沃野乳业', sector: 'consumer',
    basePrice: 10, floor: 3,
    profile: { trend: 0.3, vol: 0.7, luck: 0.2 },
    personality: '食品饮料：成本与需求两端拉扯',
  },
  {
    code: '900902', name: '佳选食品', sector: 'consumer',
    basePrice: 5, floor: 2,
    profile: { trend: 0.15, vol: 0.9, luck: -0.35 },
    personality: '调味品小厂：原料涨价传导不畅，利润被两头挤',
  },
  {
    code: '900903', name: '尚品家居', sector: 'consumer',
    basePrice: 18, floor: 5,
    profile: { trend: 0.1, vol: 1.0, luck: 0.15 },
    personality: '家居零售：跟地产同呼吸，装修需求就是它的命门',
  },

  // ---------- 材料 materials ----------
  {
    code: '901001', name: '金岭矿业', sector: 'materials',
    basePrice: 8, floor: 2,
    profile: { trend: 0.35, vol: 1.4, luck: 0.0 },
    personality: '有色资源：金价铜价大涨它就飞，也最容易暴涨暴跌',
  },
  {
    code: '901002', name: '长风钢铁', sector: 'materials',
    basePrice: 7, floor: 2,
    profile: { trend: -0.2, vol: 0.8, luck: -0.3 },
    personality: '钢铁龙头：产能过剩与地产需求的双重挤压',
  },
  {
    code: '901003', name: '磐石建材', sector: 'materials',
    basePrice: 13, floor: 4,
    profile: { trend: 0.05, vol: 0.9, luck: 0.25 },
    personality: '水泥建材：区域性垄断，有淡旺季，重资产慢变量',
  },

  // ---------- 农业 agriculture ----------
  {
    code: '901101', name: '丰源种业', sector: 'agriculture',
    basePrice: 12, floor: 4,
    profile: { trend: 0.4, vol: 1.2, luck: -0.25 },
    personality: '种业：政策与粮价双驱动，转基因题材弹性大',
  },
  {
    code: '901102', name: '牧原农牧', sector: 'agriculture',
    basePrice: 20, floor: 6,
    profile: { trend: 0.25, vol: 1.6, luck: -0.5 },
    personality: '养殖：猪周期之王，也是猪周期唯一的祭品',
  },

  // ---------- 传媒 media ----------
  {
    code: '901201', name: '星野传媒', sector: 'media',
    basePrice: 15, floor: 5,
    profile: { trend: 0.3, vol: 1.5, luck: -0.3 },
    personality: '影视传媒：商誉高悬，一部片子扑街就计提',
  },
  {
    code: '901202', name: '云图游戏', sector: 'media',
    basePrice: 24, floor: 7,
    profile: { trend: 0.5, vol: 1.35, luck: 0.05 },
    personality: '游戏公司：版号就是生命线，爆款与监管轮流坐庄',
  },
];

export const POOL_MAP = STOCK_POOL.reduce((acc, s) => {
  acc[s.code] = s;
  return acc;
}, {});

/**
 * 按 sector 分组（新闻匹配用）
 */
export function stocksOfSector(sector) {
  return STOCK_POOL.filter((s) => s.sector === sector);
}

/**
 * 按 code 取股票（取不到返回 null，避免 undefined 静默传播）
 */
export function stockOfCode(code) {
  return POOL_MAP[code] || null;
}
