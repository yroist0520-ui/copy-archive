#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据库备份：使用 SQLite 在线备份 API 生成一致性快照，保留最近 30 份。"""

import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "copyarchive.db"
BACKUP_DIR = ROOT / "backups"


def main():
    if not DB.exists():
        print("数据库不存在，尚未产生数据。")
        return 1
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = BACKUP_DIR / f"copyarchive-{stamp}.db"
    source = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    dest = sqlite3.connect(target)
    with dest:
        source.backup(dest)
    dest.close()
    source.close()

    files = sorted(BACKUP_DIR.glob("copyarchive-*.db"), reverse=True)
    for old in files[30:]:
        old.unlink()
    print(f"备份完成：{target}（{target.stat().st_size} bytes）")
    print(f"保留备份数：{min(len(files), 30)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
