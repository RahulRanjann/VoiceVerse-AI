# syntax=docker/dockerfile:1.7
ARG CLAMAV_IMAGE=clamav/clamav:1.5.3
FROM ${CLAMAV_IMAGE}

# Feature-length masters are larger than ClamAV's mail-attachment defaults.
# The scanner remains isolated on the private Compose/Kubernetes network.
RUN sed -i -E 's|^#?[[:space:]]*StreamMaxLength[[:space:]].*$|StreamMaxLength 20G|' /etc/clamav/clamd.conf \
  && sed -i -E 's|^#?[[:space:]]*MaxScanSize[[:space:]].*$|MaxScanSize 20G|' /etc/clamav/clamd.conf \
  && sed -i -E 's|^#?[[:space:]]*MaxFileSize[[:space:]].*$|MaxFileSize 20G|' /etc/clamav/clamd.conf
