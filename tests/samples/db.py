import sqlite3

from sqlalchemy import String, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

engine = create_engine("sqlite:////definitely/not/here/prod.db")


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(100))
    active: Mapped[bool] = mapped_column(default=True)


def active_emails(session: Session, domain: str):
    statement = select(User).where(User.active.is_(True))
    users = session.execute(statement).scalars().all()
    emails = []
    for user in users:
        if user.email.endswith(domain):
            emails.append(user.email)
    session.commit()
    return emails


def with_engine(min_id: int):
    with Session(engine) as session:
        count = session.scalar(select(User.id).where(User.id > min_id))
        return count + 1


def raw_sqlite(name: str):
    conn = sqlite3.connect("/definitely/not/here/app.db")
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM t WHERE name = ?", (name,))
    row = cursor.fetchone()
    conn.close()
    return row[0]


def memory_sqlite():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE t (x INTEGER)")
    conn.execute("INSERT INTO t VALUES (41)")
    return conn.execute("SELECT x + 1 FROM t").fetchone()[0]
