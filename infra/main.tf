terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

data "aws_vpc" "default" {
  default = true
}

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023*-x86_64"]
  }
}

resource "aws_key_pair" "main" {
  key_name   = "apparelflow-key"
  public_key = file(pathexpand(var.public_key_path))
}

# ---------- Security groups ----------
resource "aws_security_group" "frontend" {
  name        = "af-frontend-sg"
  description = "Security group for ApparelFlow frontend EC2"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "SSH (open for CI/CD GitHub Actions runners)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "af-frontend-sg"
  }
}

resource "aws_security_group" "backend" {
  name        = "af-backend-sg"
  description = "Security group for ApparelFlow backend EC2"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "Node API from Frontend SG only"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.frontend.id]
  }

  ingress {
    description = "SSH (open for CI/CD GitHub Actions runners)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "af-backend-sg"
  }
}

resource "aws_security_group" "db" {
  name        = "af-db-sg"
  description = "Security group for PostgreSQL RDS (only backend allowed)"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "PostgreSQL port from Backend SG only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.backend.id]
  }

  ingress {
    description = "PostgreSQL from developer IP (migrations)"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.my_ip_cidr]
  }

  tags = {
    Name = "af-db-sg"
  }
}

# ---------- RDS PostgreSQL ----------
resource "aws_db_instance" "pg" {
  identifier             = "apparelflow-db"
  engine                 = "postgres"
  engine_version         = "16"
  instance_class         = "db.t3.micro"
  allocated_storage      = 20
  storage_type           = "gp2"
  db_name                = "apparelflow"
  username               = "afadmin"
  password               = var.db_password
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = false
  backup_retention_period = 0
  skip_final_snapshot    = true

  tags = {
    Name = "apparelflow-db"
  }
}

# ---------- EC2: backend ----------
resource "aws_instance" "backend" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = "t3.micro"
  key_name               = aws_key_pair.main.key_name
  vpc_security_group_ids = [aws_security_group.backend.id]

  user_data = <<-EOT
    #!/bin/bash
    dnf install -y git nodejs20 postgresql16
    npm install -g pm2
    cat > /etc/apparelflow.env <<ENV
    PORT=3000
    NODE_ENV=production
    JWT_SECRET=${var.jwt_secret}
    DATABASE_URL=postgres://afadmin:${var.db_password}@${aws_db_instance.pg.address}:5432/apparelflow?sslmode=require
    ENV
    chown ec2-user:ec2-user /etc/apparelflow.env
    chmod 600 /etc/apparelflow.env
    mkdir -p /opt/apparelflow && chown -R ec2-user:ec2-user /opt/apparelflow
  EOT

  tags = {
    Name = "apparelflow-backend"
  }
}

# ---------- EC2: frontend ----------
resource "aws_instance" "frontend" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = "t3.micro"
  key_name               = aws_key_pair.main.key_name
  vpc_security_group_ids = [aws_security_group.frontend.id]

  user_data = <<-EOT
    #!/bin/bash
    dnf install -y nginx
    mkdir -p /var/www/apparelflow && chown -R ec2-user:ec2-user /var/www/apparelflow
    chmod -R 755 /var/www/apparelflow
    cat > /etc/nginx/nginx.conf << 'CONF'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;
include /usr/share/nginx/modules/*.conf;
events {
    worker_connections 1024;
}
http {
    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';
    access_log  /var/log/nginx/access.log  main;
    sendfile            on;
    tcp_nopush          on;
    keepalive_timeout   65;
    types_hash_max_size 4096;
    include             /etc/nginx/mime.types;
    default_type        application/octet-stream;
    include /etc/nginx/conf.d/*.conf;
}
CONF
    cat > /etc/nginx/conf.d/apparelflow.conf <<NGINX
    server {
      listen 80 default_server;
      root /var/www/apparelflow;
      index index.html;
      location /api/ {
        proxy_pass http://${aws_instance.backend.private_ip}:3000/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
      }
      location / {
        try_files \$uri \$uri/ /index.html;
      }
    }
    NGINX
    systemctl enable --now nginx
  EOT

  tags = {
    Name = "apparelflow-frontend"
  }
}
