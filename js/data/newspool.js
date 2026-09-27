/**
 * 新闻池
 *
 * 为什么是 .js 而不是 .json？
 * 微信小游戏的打包器不支持 import JSON —— 它会把路径当模块名
 * 自动补 .js 后缀，去找 "xxx.json.js" 从而报错。
 * 因此数据一律以 .js 模块形式导出。
 *
 * ============ 与旧设计的区别 ============
 *
 * 旧：每条新闻写死 target = 某只股票代码，新闻只能服务固定三只股。
 * 新：每条新闻声明 sector（它讲的是哪个行业），与股票池的 sector 匹配。
 *     于是"同一批新闻"可以服务任意一局抽出来的三只股票。
 *
 * ============ 三种"错配"（玩家要求）============
 *
 * kind:
 *   'relevant'   —— sector 命中该股 → 影响真实生效（drift 按 truth 正/负）
 *   'irrelevant' —— sector 不命中（例：船舶运输利好，但你买的是陆运）
 *                   → **不影响股价**，但新闻卡照样展示，迷惑玩家
 *   'pressured'  —— 消息面是利好，但公司业绩仍承压
 *                   → drift 为负（利好出尽 / 成本传导受阻）
 *
 * truth:
 *   true  = 消息本身为真
 *   false = 假消息（评级里会"轻微背离"，不直接点破）
 *
 * impact.drift : 该股每月偏移（%），仅在 kind='relevant' 时按 truth 生效；
 *                kind='pressured' 时取 drift 的**负向**（利好但跌）
 * impact.turns : 影响持续的回合数
 */

/**
 * 生成一条新闻
 */
function news(id, sector, headline, body, opts = {}) {
  return {
    id,
    sector,
    headline,
    body,
    source: opts.source || '盘面快讯',
    link: opts.link || 'industry', // direct | industry | macro
    truth: opts.truth !== false,
    credibility: typeof opts.credibility === 'number' ? opts.credibility : 0.8,
    kind: opts.kind || 'relevant', // relevant | irrelevant | pressured
    theme: opts.theme || 'neutral', // bull | bear | neutral（用于按市场风格筛选）
    impact: {
      drift: typeof opts.drift === 'number' ? opts.drift : 0,
      turns: opts.turns || 2,
    },
  };
}

// ============================================================
//  白酒 liquor
// ============================================================
const LIQUOR = [
  news('nl_01', 'liquor', '白酒板块迎旺季备货，渠道打款积极', '多家经销商反馈高端白酒节前备货量同比增长，渠道信心回暖。', { source: '证券日报', drift: 3.2, theme: 'bull' }),
  news('nl_02', 'liquor', '传：龙头酒企将提价 10%', '市场传闻主要酒企将于下月统一提价，尚未获公司确认。', { source: '市场传闻', truth: false, credibility: 0.4, drift: 4.5, theme: 'bull', link: 'direct' }),
  news('nl_03', 'liquor', '白酒库存高企，部分品牌降价去库存', '渠道库存处于历史高位，二三线品牌率先降价促销，价格体系承压。', { source: '行业调研', drift: -3.6, theme: 'bear' }),
  news('nl_04', 'liquor', '白酒板块估值处于历史低位，长线资金关注度提升', '多家机构认为板块估值已具备安全边际，北向资金连续净买入。', { source: '券商研报', drift: 2.8, theme: 'neutral' }),
  news('nl_05', 'liquor', '限制三公消费传闻再起，高端白酒需求承压', '市场担忧相关政策收紧，高端白酒终端动销放缓。', { source: '财经网', truth: false, credibility: 0.35, drift: -4.2, theme: 'bear', link: 'macro' }),
  news('nl_06', 'liquor', '白酒龙头三季报预增，机构上调目标价', '公司预计前三季度净利同比增长约 15%，多家机构上调目标价。', { source: '公司公告', drift: 4.0, theme: 'bull', link: 'direct' }),
  // 利好但业绩承压：需求回暖，但成本（包装/人工）上涨吃掉利润
  news('nl_07', 'liquor', '白酒消费回暖，但包装与人工成本上涨侵蚀利润', '终端动销边际改善，然而玻璃瓶与包材价格上涨，公司毛利率环比仍下滑。', { source: '行业分析', kind: 'pressured', drift: 3.0, theme: 'neutral' }),
];

// ============================================================
//  地产 realestate
// ============================================================
const REALESTATE = [
  news('nr_01', 'realestate', '央行降准 0.5 个百分点，释放长期资金', '流动性宽松预期升温，地产板块获得估值支撑。', { source: '央行', drift: 2.8, theme: 'bull', link: 'macro' }),
  news('nr_02', 'realestate', '多地松绑限购，地产销售环比回暖', '十余个城市调整限购政策，重点城市网签量环比上升。', { source: '住建部', drift: 4.2, theme: 'bull' }),
  news('nr_03', 'realestate', '房企融资“三道红线”加码，开发贷全面收紧', '监管要求压降有息负债，高杠杆房企再融资窗口几近关闭。', { source: '监管文件', drift: -6.5, theme: 'bear', link: 'macro' }),
  news('nr_04', 'realestate', '传：某头部房企信托贷款逾期，公司称“消息不实”', '传言称一笔信托计划未能按期兑付，公司回应称经营正常。', { source: '市场传闻', truth: false, credibility: 0.35, drift: -4.8, theme: 'bear', link: 'direct' }),
  news('nr_05', 'realestate', '房企年报预亏，审计机构出具“无法表示意见”', '公司预计全年大额亏损，审计机构提示持续经营能力存在重大不确定性。', { source: '公司公告', drift: -8.5, theme: 'bear', link: 'direct' }),
  news('nr_06', 'realestate', '保障房与城市更新提速，地产链需求边际改善', '专项债加速发行，基建与保障房开工提速，带动建材与地产链预期回暖。', { source: '发改委', drift: 3.4, theme: 'neutral', link: 'macro' }),
  // 利好但没有传导到这家公司：土地市场回暖，但该房企未拿地
  news('nr_07', 'realestate', '土地市场溢价率回升，多家房企积极补仓', '核心城市土拍热度回升，多家央国企溢价拿地。', { source: '土地市场', kind: 'pressured', drift: 2.2, theme: 'neutral', link: 'industry' }),
];

// ============================================================
//  新能源 newenergy
// ============================================================
const NEWENERGY = [
  news('nn_01', 'newenergy', '碳酸锂价格企稳回升，电池成本压力缓解', '上游材料价格止跌，电池厂毛利预期改善。', { source: '上海有色', drift: 3.4, theme: 'bull' }),
  news('nn_02', 'newenergy', '传：龙头电池厂获欧洲车企百亿订单', '传闻称公司与欧洲车企签订长期供货协议，尚未公告。', { source: '市场传闻', truth: false, credibility: 0.35, drift: 5.1, theme: 'bull', link: 'direct' }),
  news('nn_03', 'newenergy', '新能源车补贴退坡，产业链排产下调', '补贴政策边际收紧，部分车企下调全年销量目标。', { source: '工信部', drift: -4.6, theme: 'bear', link: 'macro' }),
  news('nn_04', 'newenergy', '四万亿投资计划出台，电网与新能源板块率先反弹', '大规模经济刺激计划偏好基建与新能源，产业链午后直线拉升。', { source: '新华财经', drift: 6.5, theme: 'bull', link: 'macro' }),
  news('nn_05', 'newenergy', '传：海外对华电池加征关税', '市场传闻海外将对中国电池加征高额关税，出口链承压。', { source: '外媒', truth: false, credibility: 0.25, drift: -5.2, theme: 'bear', link: 'macro' }),
  news('nn_06', 'newenergy', '新技术路线突破，能量密度大幅提升', '实验室宣布新型电池能量密度提升 30%，产业化仍需时日。', { source: '科研院所', drift: 4.8, theme: 'bull' }),
  // 利好但业绩承压：订单大涨，但价格战导致增收不增利
  news('nn_07', 'newenergy', '电池销量大增，但价格战导致增收不增利', '公司出货量同比翻倍，然而产品均价大幅下行，毛利率同比明显收窄。', { source: '财报解读', kind: 'pressured', drift: 4.0, theme: 'neutral', link: 'direct' }),
];

// ============================================================
//  能源 energy
// ============================================================
const ENERGY = [
  news('ne_01', 'energy', '国际油价大涨 5%，能源板块集体走强', '地缘局势紧张推升原油价格，石油石化板块获资金追捧。', { source: '路透社', drift: 4.6, theme: 'bull', link: 'macro' }),
  news('ne_02', 'energy', 'OPEC+ 意外增产，国际油价单日重挫', '产油国联盟宣布增产超预期，油价大跌拖累能源股。', { source: 'OPEC', drift: -5.4, theme: 'bear', link: 'macro' }),
  // 假消息：传出重大油气田发现
  news('ne_03', 'energy', '传：渤海发现亿吨级大油田', '有报道称渤海海域勘探获重大突破，公司未予置评。', { source: '市场传闻', truth: false, credibility: 0.3, drift: 5.8, theme: 'bull', link: 'direct' }),
  news('ne_04', 'energy', '成品油调价窗口开启，炼化利润改善', '发改委上调成品油价，炼化企业价差走阔。', { source: '发改委', drift: 2.6, theme: 'neutral' }),
  news('ne_05', 'energy', '天然气需求旺季不及预期，价格回落', '暖冬导致采暖需求偏弱，天然气现货价格大幅回落。', { source: '能源局', drift: -3.8, theme: 'bear' }),
  // 利好但与主营无关：油价涨利好上游，但这家主营炼化（成本反而上升）
  news('ne_06', 'energy', '油价走高，上游勘探板块显著受益', '原油价格上涨直接增厚上游勘探业务利润。', { source: '行业分析', kind: 'irrelevant', drift: 3.5, theme: 'neutral', link: 'industry' }),
];

// ============================================================
//  科技 tech
// ============================================================
const TECH = [
  news('nt_01', 'tech', '国产替代加速，信创订单集中释放', '多地启动信创招标，国产软硬件订单集中落地。', { source: '工信部', drift: 4.4, theme: 'bull' }),
  news('nt_02', 'tech', '传：某科技龙头获国家大基金战略入股', '市场传闻大基金将入股公司，尚未有正式公告。', { source: '市场传闻', truth: false, credibility: 0.35, drift: 6.2, theme: 'bull', link: 'direct' }),
  news('nt_03', 'tech', '海外出口管制升级，科技板块承压', '海外收紧高端芯片与设备出口，产业链供应风险上升。', { source: '外媒', drift: -6.8, theme: 'bear', link: 'macro' }),
  news('nt_04', 'tech', 'AI 算力投资超预期，服务器产业链受益', '互联网大厂上调资本开支，AI 服务器订单饱满。', { source: '券商研报', drift: 5.6, theme: 'bull' }),
  news('nt_05', 'tech', '科技股估值高企，机构提示回调风险', '板块估值处于近三年高位，部分机构开始兑现收益。', { source: '券商研报', drift: -3.2, theme: 'neutral' }),
  news('nt_06', 'tech', '研发投入加码，新产品发布会临近', '公司宣布加大研发投入，下月将召开新品发布会。', { source: '公司公告', drift: 3.0, theme: 'neutral', link: 'direct' }),
  // 利好但业绩承压：订单增长，但研发费用与汇兑损失拖累利润
  news('nt_07', 'tech', '订单增长强劲，但研发费用激增拖累当期利润', '公司在手订单创历史新高，然而研发投入与汇兑损失使净利润同比下滑。', { source: '财报解读', kind: 'pressured', drift: 4.5, theme: 'neutral', link: 'direct' }),
];

// ============================================================
//  运输 transport（这里是玩家点名要的"船运 vs 陆运"错配）
// ============================================================
const TRANSPORT = [
  // ★ 船舶运输利好 —— 但股票池里的运输股有"陆运（大秦铁路）"与"港口水运（上港集团）"
  news('np_01', 'transport', 'BDI 指数大涨，船舶运输业景气度飙升', '波罗的海干散货指数创年内新高，远洋航运运价大幅上行。', { source: '波罗的海交易所', drift: 4.8, theme: 'bull', link: 'industry' }),
  news('np_02', 'transport', '外贸出口超预期，港口吞吐量创新高', '海关数据显示出口同比高增，主要港口集装箱吞吐量创历史新高。', { source: '海关总署', drift: 3.6, theme: 'bull' }),
  news('np_03', 'transport', '煤炭运量下滑，铁路货运需求转弱', '受下游电厂库存高企影响，铁路煤炭运量同比下降。', { source: '铁路总局', drift: -4.2, theme: 'bear' }),
  news('np_04', 'transport', '传：航运巨头将大幅上调运价', '市场传闻主要航运联盟下月集体涨价，尚未获证实。', { source: '市场传闻', truth: false, credibility: 0.35, drift: 5.4, theme: 'bull', link: 'direct' }),
  news('np_05', 'transport', '油价高企推升运输成本，物流企业利润承压', '燃油成本占运输成本比重上升，行业毛利率普遍下滑。', { source: '物流协会', drift: -4.6, theme: 'bear', link: 'industry' }),
  // ★★ 关键：船运利好，但主营陆运 → 完全无关
  news('np_06', 'transport', '远洋航运运价翻倍，船东赚得盆满钵满', '集运与干散货运价同步上行，航运公司业绩爆发。', { source: '航运周刊', kind: 'irrelevant', drift: 5.0, theme: 'bull', link: 'industry' }),
  // ★ 利好但业绩承压：运价上涨，但燃油成本涨得更快
  news('np_07', 'transport', '运价上调，但燃油成本涨幅更大', '公司上调运价以应对成本，然而燃油支出同比激增，毛利率仍环比走低。', { source: '财报解读', kind: 'pressured', drift: 3.2, theme: 'neutral', link: 'direct' }),
];

// ============================================================
//  金融 finance
// ============================================================
const FINANCE = [
  news('nf_01', 'finance', '降准落地，银行息差压力缓解', '央行降准释放长期低成本资金，银行负债成本下行。', { source: '央行', drift: 2.4, theme: 'bull', link: 'macro' }),
  news('nf_02', 'finance', '不良贷款率抬头，资产质量引发担忧', '部分行业风险暴露，银行不良率环比微升。', { source: '银保监会', drift: -3.6, theme: 'bear', link: 'macro' }),
  news('nf_03', 'finance', '传：将下调存量房贷利率', '市场传闻存量房贷利率将统一下调，银行息差承压。', { source: '市场传闻', truth: false, credibility: 0.4, drift: -3.0, theme: 'neutral', link: 'macro' }),
  news('nf_04', 'finance', '银行三季报超预期，净息差企稳', '多家银行披露三季报，净息差环比企稳，资产质量改善。', { source: '公司公告', drift: 3.8, theme: 'bull', link: 'direct' }),
  news('nf_05', 'finance', '金融让利实体，银行盈利增速放缓', '政策引导金融向实体让利，银行营收增速边际回落。', { source: '国务院', kind: 'pressured', drift: 2.0, theme: 'neutral', link: 'macro' }),
];

// ============================================================
//  医药 pharma
// ============================================================
const PHARMA = [
  news('nh_01', 'pharma', '创新药获批上市，市场空间打开', '公司自主研发的新药获批，券商测算峰值销售可观。', { source: '药监局', drift: 5.2, theme: 'bull', link: 'direct' }),
  news('nh_02', 'pharma', '集采落地，药品大幅降价', '新一轮集采结果公布，中标品种价格平均降幅超 50%。', { source: '医保局', drift: -6.4, theme: 'bear', link: 'macro' }),
  news('nh_03', 'pharma', '传：重磅新药三期临床失败', '市场传闻某重磅在研管线三期临床未达主要终点。', { source: '市场传闻', truth: false, credibility: 0.3, drift: -5.6, theme: 'bear', link: 'direct' }),
  news('nh_04', 'pharma', '流感季提前，相关药品需求激增', '多地流感病例上升，抗病毒与感冒类药物终端动销旺盛。', { source: '疾控中心', drift: 4.4, theme: 'bull' }),
  // 利好但业绩承压：新药获批，但销售费用高企
  news('nh_05', 'pharma', '新药放量在即，但销售费用高企拖累利润', '新产品进入放量期，然而学术推广费用大幅增加，短期利润承压。', { source: '财报解读', kind: 'pressured', drift: 3.8, theme: 'neutral', link: 'direct' }),
];

// ============================================================
//  消费 consumer
// ============================================================
const CONSUMER = [
  news('nc_01', 'consumer', '消费复苏，社零增速超预期', '社会消费品零售总额同比增速超出市场预期。', { source: '统计局', drift: 3.6, theme: 'bull', link: 'macro' }),
  news('nc_02', 'consumer', '原奶价格上行，乳企成本承压', '生鲜乳收购价连续上涨，下游乳制品企业毛利承压。', { source: '农业部', drift: -3.4, theme: 'bear' }),
  news('nc_03', 'consumer', '传：龙头企业将全面提价', '市场传闻龙头食品企业将对全线产品提价 5%~8%。', { source: '市场传闻', truth: false, credibility: 0.45, drift: 4.2, theme: 'bull', link: 'direct' }),
  news('nc_04', 'consumer', '公司回购股份并提高分红比例', '公司公告拟回购股份并提升分红比例，股东回报增强。', { source: '公司公告', drift: 3.2, theme: 'neutral', link: 'direct' }),
];

// ============================================================
//  材料 materials
// ============================================================
const MATERIALS = [
  news('nm_01', 'materials', '金价创历史新高，贵金属板块大涨', '避险情绪升温，国际金价突破历史高点。', { source: '路透社', drift: 5.8, theme: 'bull', link: 'macro' }),
  news('nm_02', 'materials', '铜价飙升，有色资源股集体走强', '全球铜矿供应扰动，铜价大幅上行。', { source: '伦敦金属交易所', drift: 4.8, theme: 'bull', link: 'macro' }),
  news('nm_03', 'materials', '钢材价格下跌，钢铁企业利润承压', '地产需求疲弱叠加产能过剩，钢价持续走低。', { source: '钢铁协会', drift: -5.2, theme: 'bear', link: 'industry' }),
  news('nm_04', 'materials', '传：大宗商品将迎来超级周期', '多家投行看多大宗商品，认为将开启新一轮超级周期。', { source: '投行报告', truth: false, credibility: 0.3, drift: 5.4, theme: 'bull', link: 'macro' }),
  // 利好但业绩承压：金价涨，但矿山品位下降、成本上升
  news('nm_05', 'materials', '金价上涨，但矿山品位下降推高开采成本', '公司主营产品价格上涨，然而入选品位下滑、能源成本上升，单位成本同比抬升明显。', { source: '财报解读', kind: 'pressured', drift: 4.6, theme: 'neutral', link: 'direct' }),
];

// ============================================================
//  跨行业 / 大盘类（sector = 'macro'，对谁都可能"沾边"）
// ============================================================
const MACRO = [
  news('nx_01', 'macro', '央行宣布降息降准，市场流动性宽松', '央行同日下调政策利率与存款准备金率，释放宽松信号。', { source: '央行', drift: 2.0, theme: 'bull', link: 'macro' }),
  news('nx_02', 'macro', '海外市场隔夜暴跌，A 股情绪承压', '隔夜美股三大指数重挫，亚太市场普遍低开。', { source: '路透社', drift: -2.6, theme: 'bear', link: 'macro' }),
  news('nx_03', 'macro', '传：平准基金即将入场托市', '市场传闻将成立平准基金入场维稳，尚未获权威证实。', { source: '股吧传闻', truth: false, credibility: 0.3, drift: 2.4, theme: 'neutral', link: 'macro' }),
  news('nx_04', 'macro', '大规模经济刺激计划出台，市场信心提振', '一揽子稳增长政策落地，基建与制造业投资预期升温。', { source: '国务院', drift: 2.8, theme: 'bull', link: 'macro' }),
  news('nx_05', 'macro', '外资持续流出，市场成交萎缩', '北向资金连续净流出，两市成交额创阶段新低。', { source: '交易所', drift: -2.2, theme: 'bear', link: 'macro' }),
];

// ============================================================
//  农业 agriculture（第四版新增 —— 年景 y07/y11 用到）
// ============================================================
const AGRICULTURE = [
  news('na_01', 'agriculture', '中央一号文件发布，种业振兴获政策加码', '文件明确支持种业技术攻关与生物育种产业化，龙头种企受益。', { source: '农业农村部', drift: 4.6, theme: 'bull', link: 'macro' }),
  news('na_02', 'agriculture', '粮价上涨，种植链景气度上行', '小麦玉米现货价格同步走高，种植与农资环节利润改善。', { source: '粮油信息中心', drift: 3.4, theme: 'bull' }),
  news('na_03', 'agriculture', '猪价跌破成本线，养殖户深度亏损', '生猪出栏价连续下行，行业进入去产能阶段。', { source: '畜牧协会', drift: -5.2, theme: 'bear', link: 'industry' }),
  news('na_04', 'agriculture', '传：转基因品种审定将大幅放开', '市场传闻商业化审定通道将拓宽，尚未获主管部门确认。', { source: '市场传闻', truth: false, credibility: 0.35, drift: 5.6, theme: 'bull', link: 'direct' }),
  news('na_05', 'agriculture', '极端天气影响主产区，减产预期升温', '北方持续干旱叠加南方洪涝，市场担忧秋粮减产。', { source: '气象局', drift: 3.2, theme: 'neutral', link: 'macro' }),
  // 利好但业绩承压：猪价反弹，但饲料成本涨得更快
  news('na_06', 'agriculture', '猪价小幅反弹，但饲料成本涨幅更大', '出栏价环比回升，然而豆粕与玉米价格同步走高，养殖利润仍被压缩。', { source: '财报解读', kind: 'pressured', drift: 3.0, theme: 'neutral', link: 'direct' }),
];

// ============================================================
//  传媒 media（第四版新增 —— 年景 y10/y13 用到）
// ============================================================
const MEDIA = [
  news('ng_01', 'media', '游戏版号恢复发放，行业供给端改善', '新一批版号下发，多款重点产品获批，行业景气度回升。', { source: '新闻出版署', drift: 5.4, theme: 'bull', link: 'macro' }),
  news('ng_02', 'media', 'AI 内容生成降本显著，传媒公司毛利率改善', '多家公司披露 AI 工具已用于内容生产，人力成本明显下降。', { source: '券商研报', drift: 4.8, theme: 'bull' }),
  news('ng_03', 'media', '传：将出台游戏充值限额新规', '市场传闻监管部门将限制未成年人充值额度，尚未证实。', { source: '市场传闻', truth: false, credibility: 0.3, drift: -6.0, theme: 'bear', link: 'macro' }),
  news('ng_04', 'media', '影视公司商誉大额减值，全年巨亏', '公司公告计提商誉减值准备，全年业绩由盈转亏。', { source: '公司公告', drift: -7.6, theme: 'bear', link: 'direct' }),
  news('ng_05', 'media', '爆款影片带动票房创同期新高', '暑期档票房超市场预期，多家影视公司参与出品分账。', { source: '电影局', drift: 4.2, theme: 'bull' }),
  // 利好但没有传导：行业回暖，但这家的主力产品已过生命周期
  news('ng_06', 'media', '行业整体回暖，但公司主力产品流水持续下滑', '行业数据向好，然而公司主打产品进入衰退期，流水同比下滑明显。', { source: '财报解读', kind: 'pressured', drift: 3.6, theme: 'neutral', link: 'direct' }),
];

/**
 * 全部新闻
 */
export const NEWS_POOL = [
  ...LIQUOR,
  ...REALESTATE,
  ...NEWENERGY,
  ...ENERGY,
  ...TECH,
  ...TRANSPORT,
  ...FINANCE,
  ...PHARMA,
  ...CONSUMER,
  ...MATERIALS,
  ...AGRICULTURE,
  ...MEDIA,
  ...MACRO,
];

export const NEWS_POOL_MAP = NEWS_POOL.reduce((acc, n) => {
  acc[n.id] = n;
  return acc;
}, {});

/**
 * 取某个行业可用的新闻（含 macro 通用新闻）
 *
 * @param {string} sector 股票行业
 * @returns {Array} 新闻列表
 */
export function newsForSector(sector) {
  return NEWS_POOL.filter((n) => n.sector === sector || n.sector === 'macro');
}

/**
 * 按"错配类型"筛选
 */
export function newsByKind(kind) {
  return NEWS_POOL.filter((n) => n.kind === kind);
}
