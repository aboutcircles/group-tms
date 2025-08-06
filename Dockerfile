FROM python:3.10-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src /app/service/src

CMD ["python", "service/src/LBP_backing.py"]
