variable "region" {
  type        = string
  default     = "ap-south-1"
  description = "AWS region (Mumbai closest to Sri Lanka)"
}

variable "my_ip_cidr" {
  type        = string
  description = "Your IP address for SSH access (e.g. 1.2.3.4/32)"
}

variable "db_password" {
  type        = string
  sensitive   = true
  description = "Master password for PostgreSQL RDS database"
}

variable "public_key_path" {
  type        = string
  default     = "~/.ssh/apparelflow.pub"
  description = "Path to SSH public key for EC2 instances"
}

variable "jwt_secret" {
  type        = string
  sensitive   = true
  description = "JWT secret key for backend token authentication"
}
