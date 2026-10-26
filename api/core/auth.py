"""Authenticate the prototype guest account for every private API operation."""
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from sqlalchemy.orm import Session

from core.database import get_db
from core.security import verify_password
from models.models import User

basic = HTTPBasic(auto_error=False)


def authenticated_user(
    credentials: HTTPBasicCredentials | None = Depends(basic),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    user = db.query(User).filter(User.username == credentials.username).first()
    if user is None or not verify_password(credentials.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return user


def require_owner(user_id: int, user: User) -> None:
    if user.id != user_id:
        raise HTTPException(status_code=403, detail="This progress belongs to another player")
