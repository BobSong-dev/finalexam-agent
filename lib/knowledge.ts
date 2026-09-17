/**
 * 知识点键归一化。题目、考点卡片与掌握度记录通过同一个键连接，
 * 这样模型措辞上的细微差别（空格、标点、全角/半角）不会切断三者的关系。
 * 纯函数，浏览器与服务端共用。
 */
export function normalizeKnowledgeKey(title: string): string {
  return (
    title
      .normalize("NFKC")
      .toLowerCase()
      // 去掉常见的标点、书名号、括号与空白；保留中英文、数字与下划线
      .replace(/[\s　\p{P}\p{S}]+/gu, "")
      .slice(0, 120)
  );
}

/** 两个键完全相等，或一方包含另一方且长度差不超过 40%（容忍「二重积分」vs「二重积分的区域变换」）。 */
export function knowledgeKeysRelated(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length < 2) return false;
  return longer.includes(shorter) && (longer.length - shorter.length) / longer.length <= 0.4;
}
