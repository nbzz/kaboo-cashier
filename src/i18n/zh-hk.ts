export const zhHk = {
  appName: "會員記賬系統",
  login: "Google 登入",
  logout: "登出",
  quickEntry: "快速記賬",
  members: "會員管理",
  transactions: "流水查詢",
  priceList: "價目表",
  searchMember: "搜尋會員姓名或電話",
  selectItems: "選擇服務項目",
  submit: "提交",
  topup: "充值",
  save: "保存",
  newMember: "新增會員",
} as const;

export type ZhHkKeys = keyof typeof zhHk;
