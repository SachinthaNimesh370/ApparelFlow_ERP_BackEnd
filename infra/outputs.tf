output "frontend_url" {
  description = "Public URL for ApparelFlow Web Application"
  value       = "http://${aws_instance.frontend.public_ip}"
}

output "backend_ip" {
  description = "Public IP of Backend EC2 instance (for SSH and deployment)"
  value       = aws_instance.backend.public_ip
}

output "rds_endpoint" {
  description = "Private hostname endpoint for RDS PostgreSQL"
  value       = aws_db_instance.pg.address
}
