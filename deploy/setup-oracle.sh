#!/usr/bin/env bash
#
# Keystone - one-time bootstrap for an Oracle Cloud Ubuntu instance.
#
# Run as the default user (usually "ubuntu") on a fresh instance:
#   bash deploy/setup-oracle.sh
#
# This installs Docker and opens ports 80/443 in the instance firewall.
# You must ALSO open those ports in the VCN security list (see README).

set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
	echo "Run this as a normal user with sudo access, not as root." >&2
	exit 1
fi

echo "==> Installing Docker"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg iptables-persistent

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg |
	sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
	sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker "$USER"

echo "==> Opening ports 80 and 443"
# Oracle's Ubuntu images ship with a restrictive iptables ruleset.
sudo iptables -I INPUT 1 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 1 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save

echo
echo "Done. Log out and back in so the docker group applies, then:"
echo "  cp .env.example .env   # set DOMAIN"
echo "  docker compose up -d --build"
