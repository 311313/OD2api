# -*- coding: utf-8 -*-
"""
褰诲簳淇?499锛氫笉鍐嶇敤 res 'close' 浜嬩欢鍒ゅ鎴风鏂紑銆?
涓轰粈涔堟斁寮?close锛?  瀹為獙璇佹槑瀹冨湪涓夌鎯呭喌涓嬮兘浼氳Е鍙戯紝涓旀棤娉曞彲闈犲尯鍒嗭細
    1. 姝ｅ父鍐欏畬锛坵ritableEnded=true锛夆€?宸茬敤鍒ゆ嵁鎺掗櫎
    2. keep-alive 澶嶇敤鏃舵棫 res 寤惰繜瑙﹀彂锛坵ritableEnded=false锛夆€?鎺掗櫎涓嶆帀
    3. 瀹㈡埛绔湡鏂紑锛坵ritableEnded=false锛夆€?鍜?2 鏃犳硶鍖哄垎

  绗?2 绉嶅氨鏄?下游网关 鐨勬儏鍐碉細杩炵画浼氳瘽銆佸鐢ㄨ繛鎺ャ€佹瘡娆￠兘鏈夊畬鏁磋緭鍑恒€?  鍙鍐欏惊鐜繕鍦ㄨ窇锛宑lose 涓€鍒板氨 clientGone=true锛屾妸鎴愬姛璇锋眰璁版垚 499銆?
姝ｇ‘鐨勫垽鎹細鐪?*鏁版嵁鏄惁鍐欐垚鍔?*銆?  res.write() 杩斿洖 false 琛ㄧず缂撳啿鍖烘弧锛堟甯歌儗鍘嬶級锛屼笉鏄敊璇€?  鐪熸鐨勬柇寮€浼氳 write 鎶涢敊锛圗PIPE / ERR_STREAM_DESTROYED锛夈€?
  鎵€浠ワ細鑳戒笉 catch 鍦版妸鏁翠釜娴佸啓瀹?= 瀹㈡埛绔竴鐩村湪鏀?= 鎴愬姛銆?  鍙湁 write/read 鎶涢敊鎵嶆槸鏂紑銆?
淇硶锛?  1. 鍒犳帀 close 鐩戝惉鍣紙瀹冨彧鐢ㄦ潵 cancel reader锛屾敼涓?finally 閲屽仛锛?  2. clientGone 鍙湪 write 鎶涢敊鏃剁疆 true
"""

P = 'src/proxy.js'
s = open(P, encoding='utf-8').read()

# 鈹€鈹€ 1. 鍒犳帀 onClose 瀹氫箟涓庢敞鍐?鈹€鈹€
OLD_DEF = """  const onClose = () => {
    // [DIAG] \u4e34\u65f6\u8bca\u65ad\uff1a\u786e\u8ba4 close \u89e6\u53d1\u65f6\u7684\u771f\u5b9e\u72b6\u6001
    console.log('[DIAG close]', JSON.stringify({
      requestId,
      writableEnded: res.writableEnded,
      finished: res.finished,
      destroyed: res.destroyed,
      socketDestroyed: res.socket ? res.socket.destroyed : null,
      promptTokens,
      completionTokens,
      elapsedMs: Date.now() - startedAt,
    }));
    if (res.writableEnded) return;
    clientGone = true;
    try { reader.cancel(); } catch { /* ignore */ }
    fwd.dispose();
  };
  res.on('close', onClose);
"""

NEW_DEF = """  // \u4e0d\u518d\u7528 res 'close' \u5224\u5ba2\u6237\u7aef\u65ad\u5f00\u3002
  //
  // \u5b9e\u6d4b\uff08scripts/test-close-scenarios.mjs + test-isolate-499.mjs\uff09\uff1a
  //   close \u5728 keep-alive \u590d\u7528\u65f6\u4f1a\u5ef6\u8fdf\u89e6\u53d1\uff0c\u6b64\u65f6 writableEnded=false\uff0c
  //   \u548c\u300c\u5ba2\u6237\u7aef\u771f\u65ad\u5f00\u300d\u5b8c\u5168\u65e0\u6cd5\u533a\u5206\u3002
  //   下游网关 \u8fde\u7eed\u4f1a\u8bdd\u590d\u7528\u8fde\u63a5\uff0c\u4e8e\u662f\u6bcf\u6b21\u90fd\u8bef\u8bb0 499\u3002
  //
  // \u63a5\u4e0b\u6765\u9760\u300c\u5199\u662f\u5426\u6210\u529f\u300d\u5224\u65ad\uff1a\u80fd\u628a\u6574\u4e2a\u6d41\u5199\u5b8c\u5c31\u662f\u5ba2\u6237\u7aef\u4e00\u76f4\u5728\u6536\u3002
"""

if OLD_DEF not in s:
    raise SystemExit('[ERROR] onClose block not found (diag version)')
s = s.replace(OLD_DEF, NEW_DEF, 1)
print('[OK] close 鐩戝惉鍣ㄥ凡绉婚櫎')

# 鈹€鈹€ 2. 鍐欏惊鐜細write 鎶涢敊鎵嶇畻鏂紑 鈹€鈹€
OLD_WRITE = """        res.write(out);
      }
    }"""

NEW_WRITE = """        try {
          res.write(out);
        } catch {
          // \u5199\u4e0d\u51fa\u53bb\uff08EPIPE / socket \u5df2\u9500\u6bc1\uff09\u2014\u2014\u8fd9\u624d\u662f\u771f\u65ad\u5f00
          clientGone = true;
          break;
        }
      }
      if (clientGone) break;
    }"""

if OLD_WRITE not in s:
    raise SystemExit('[ERROR] write loop not found')
s = s.replace(OLD_WRITE, NEW_WRITE, 1)
print('[OK] 鍐欏惊鐜凡鏀逛负鎸?write 鎴愯触鍒ゅ畾')

# 鈹€鈹€ 3. 灏惧反鍐欏叆鍚屾牱澶勭悊 鈹€鈹€
OLD_TAIL = """    // \u5c3e\u5df4\uff08\u65e0\u7ed3\u5c3e\u7a7a\u884c\u7684\u60c5\u51b5\uff09
    if (buffer.length) {
      res.write(buffer);
      buffer = '';
    }"""

NEW_TAIL = """    // \u5c3e\u5df4\uff08\u65e0\u7ed3\u5c3e\u7a7a\u884c\u7684\u60c5\u51b5\uff09
    if (buffer.length && !clientGone) {
      try {
        res.write(buffer);
      } catch {
        clientGone = true;
      }
      buffer = '';
    }"""

if OLD_TAIL in s:
    s = s.replace(OLD_TAIL, NEW_TAIL, 1)
    print('[OK] 灏惧反鍐欏叆宸插姞淇濇姢')

# 鈹€鈹€ 4. finally 閲屼笉鍐?removeListener锛堟病鏈夌洃鍚櫒浜嗭級鈹€鈹€
OLD_FIN = """  } finally {
    res.removeListener('close', onClose);
    // \u4e3b\u52a8\u91ca\u653e reader\uff1a\u5ba2\u6237\u7aef\u65ad\u5f00\u65f6\u6d41\u53ef\u80fd\u8fd8\u6ca1\u8bfb\u5b8c\uff0c
    // \u60ac\u6302\u7684\u6d41\u4f1a\u5728 GC \u65f6\u4ea7\u751f AbortError \u5783\u573e\u3002
    try { reader.releaseLock(); } catch { /* \u5df2\u9501\u6216\u5df2\u5173 */ }
    fwd.dispose();"""

NEW_FIN = """  } finally {
    // \u4e3b\u52a8\u91ca\u653e reader\uff1a\u63d0\u524d\u65ad\u5f00\u65f6\u6d41\u53ef\u80fd\u8fd8\u6ca1\u8bfb\u5b8c\uff0c
    // \u60ac\u6302\u7684\u6d41\u4f1a\u5728 GC \u65f6\u4ea7\u751f AbortError \u5783\u573e\u3002
    try { reader.releaseLock(); } catch { /* \u5df2\u9501\u6216\u5df2\u5173 */ }
    fwd.dispose();"""

if OLD_FIN in s:
    s = s.replace(OLD_FIN, NEW_FIN, 1)
    print('[OK] finally 宸叉竻鐞?)

open(P, 'w', encoding='utf-8').write(s)

# 楠岃瘉
d = open(P, encoding='utf-8').read()
print('\n=== 楠岃瘉 ===')
print('  onClose 娈嬬暀: %d' % d.count('onClose'))
print('  addEventListener close: %d' % d.count("res.on('close'"))
print('  clientGone 鍑虹幇: %d 娆? % d.count('clientGone'))
