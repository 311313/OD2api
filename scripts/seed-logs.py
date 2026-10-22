"""灌 100 条日志，验证滚动隔离"""
import sqlite3
import datetime
import random

db = sqlite3.connect('data/gateway.db')
now = datetime.datetime.utcnow()

models = ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'glm-5.3-flash', 'claude-haiku-5.5']
accounts = [('688892ee-e35d-4c53-893a-2dbe3926021e', 'demo-account-b'),
            ('7157e07e-6ce4-46a7-b506-add473b1b840', 'demo-account-a')]

for i in range(100):
    ts = (now - datetime.timedelta(minutes=i * 3)).isoformat() + 'Z'
    acc_id, acc_name = random.choice(accounts)
    p = random.randint(100, 30000)
    c = random.randint(10, 500)
    db.execute('''
    INSERT INTO logs (ts, request_id, account_id, account_name, model, requested_model,
                      status_code, error_class, prompt_tokens, completion_tokens, total_tokens,
                      cached_tokens, ttfb_ms, total_ms, tokens_per_sec, stream, attempts,
                      client_ip, key_id, credits_used, cost_usd)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ''', (ts, f'req-scroll-{i}', acc_id, acc_name, random.choice(models), random.choice(models),
          200 if random.random() > 0.1 else 499, '' if random.random() > 0.1 else 'client_closed',
          p, c, p + c, int(p * random.uniform(0, 0.8)), random.randint(800, 3000),
          random.randint(1000, 5000), round(c / 3.0, 2), random.choice([0, 1]), 1,
          f'172.18.0.{random.randint(1, 20)}', 'key1', round((p + c) * 0.012, 2),
          round((p + c) * 1.1975 / 1e6, 6)))

db.commit()
n = db.execute('SELECT COUNT(*) FROM logs').fetchone()[0]
print('日志总数:', n)
db.close()
