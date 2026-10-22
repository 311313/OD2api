/**
 * 用刚才那 5 次实测数据算准确率。
 *
 * 上游实际扣 349 积分（23037 → 23386）
 * 网关 5 条记录合计 = 69.3 + 69.05 + 69.65 + 69.74 + 69.99
 */
const gw = [69.3, 69.05, 69.65, 69.74, 69.99];
const gwTokens = [5232, 5213, 5258, 5265, 5284];
const upstream = 349;

const sumGw = gw.reduce((a, b) => a + b, 0);
const sumTok = gwTokens.reduce((a, b) => a + b, 0);

console.log('═'.repeat(70));
console.log('积分准确性（deepseek-v4-pro，5 次 × ~5200 token）');
console.log('═'.repeat(70));
console.log(`  网关记录合计    : ${sumGw.toFixed(2)} 积分`);
console.log(`  上游实际扣      : ${upstream} 积分`);
console.log(`  差异            : ${(sumGw - upstream).toFixed(2)} 积分`);
console.log(`  准确率          : ${((1 - Math.abs(sumGw - upstream) / upstream) * 100).toFixed(1)}%`);
console.log(`  网关/上游       : ${(sumGw / upstream).toFixed(3)}×`);
console.log('');
console.log(`  总 token        : ${sumTok.toLocaleString()}`);
console.log(`  网关单价        : ${((sumGw / sumTok) * 1e6).toFixed(0)} 积分/M`);
console.log(`  上游实测单价    : ${((upstream / sumTok) * 1e6).toFixed(0)} 积分/M`);
console.log(`  表里配置        : 13,246 积分/M`);

console.log('\n' + '═'.repeat(70));
console.log('单次精度');
console.log('═'.repeat(70));
console.log('  tokens'.padStart(9) + '网关积分'.padStart(11) + '按配置算'.padStart(12) + '偏差'.padStart(10));
for (let i = 0; i < gw.length; i++) {
  const t = gwTokens[i];
  const calc = (t / 1e6) * 13246;
  console.log(
    String(t).padStart(9) +
    gw[i].toFixed(2).padStart(11) +
    calc.toFixed(2).padStart(12) +
    ((gw[i] / calc - 1) * 100).toFixed(1).padStart(9) + '%',
  );
}

console.log('\n' + '═'.repeat(70));
console.log('结论');
console.log('═'.repeat(70));
const errPct = ((sumGw / upstream) - 1) * 100;
if (Math.abs(errPct) < 5) {
  console.log(`  ✓ 准确。5 次累计误差 ${errPct.toFixed(1)}%，单价配置可用。`);
} else {
  console.log(`  ✗ 偏差 ${errPct.toFixed(1)}%，需要修正单价：`);
  console.log(`    建议单价 = 13246 × ${(upstream / sumGw).toFixed(3)} = ${Math.round(13246 * upstream / sumGw)} 积分/M`);
}
