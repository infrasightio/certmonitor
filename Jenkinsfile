// InfraSight CI/CD -- multibranch.
//
//   build (kaniko)  ->  push to the in-cluster registry  ->  commit the new
//   image tag into k8s-gitops  ->  Argo CD syncs it.
//
// Jenkins never touches the cluster directly. The only deploy action is a git
// commit, which is what makes a rollback `git revert` rather than archaeology.
//
//   main          -> namespace `infrasight`        (overlays/prod, public)
//   any other ref -> namespace `infrasight-<slug>` (overlays/<slug>, internal)
//
// Kaniko rather than docker: this cluster runs containerd and there is no
// docker socket to mount. Kaniko needs --insecure because the registry speaks
// plain HTTP on the node-local bridge.

def REGISTRY   = '192.168.49.2:32005'
def GITOPS_REPO = 'git@github.com:rgrishabh/k8s-gitops.git'

pipeline {
  agent {
    kubernetes {
      defaultContainer 'kaniko'
      yaml """
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: kaniko
      image: gcr.io/kaniko-project/executor:v1.23.2-debug
      command: ["/busybox/cat"]
      tty: true
      resources:
        requests: { cpu: "200m", memory: "512Mi" }
        limits:   { cpu: "2",    memory: "2Gi" }
    - name: git
      image: alpine/git:latest
      command: ["cat"]
      tty: true
      resources:
        requests: { cpu: "50m", memory: "64Mi" }
        limits:   { cpu: "500m", memory: "256Mi" }
"""
    }
  }

  options {
    timeout(time: 45, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    TAG      = "${env.GIT_COMMIT.take(7)}"
    SLUG     = "${env.BRANCH_NAME.toLowerCase().replaceAll(/[^a-z0-9-]/, '-').take(30)}"
    IS_PROD  = "${env.BRANCH_NAME == 'main'}"
  }

  stages {
    stage('Build backend') {
      steps {
        container('kaniko') {
          sh """
            /kaniko/executor \
              --context   \$WORKSPACE/backend \
              --dockerfile \$WORKSPACE/backend/Dockerfile \
              --destination ${REGISTRY}/infrasight/backend:${TAG} \
              --insecure --skip-tls-verify \
              --snapshot-mode=redo --single-snapshot \
              --cache=false
          """
        }
      }
    }

    stage('Build frontend') {
      steps {
        container('kaniko') {
          // Context is the repo ROOT, not ./frontend: the image also serves
          // docs/ at /docs, so the build has to span both.
          sh """
            /kaniko/executor \
              --context   \$WORKSPACE \
              --dockerfile \$WORKSPACE/frontend/Dockerfile \
              --destination ${REGISTRY}/infrasight/frontend:${TAG} \
              --insecure --skip-tls-verify \
              --snapshot-mode=redo --single-snapshot \
              --cache=false
          """
        }
      }
    }

    stage('Deploy: commit image tag to k8s-gitops') {
      steps {
        container('git') {
          sshagent(credentials: ['k8s-gitops-ssh']) {
            sh """
              set -e
              apk add --no-cache openssh-client >/dev/null 2>&1 || true
              mkdir -p ~/.ssh && ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null

              rm -rf /tmp/gitops
              git clone --depth 1 ${GITOPS_REPO} /tmp/gitops
              cd /tmp/gitops
              git config user.name  'jenkins'
              git config user.email 'jenkins@rgrishabh.in'

              if [ "${IS_PROD}" = "true" ]; then
                OVERLAY=apps/infrasight/overlays/prod
              else
                OVERLAY=apps/infrasight/overlays/${SLUG}
                # Generate a preview overlay the first time this branch builds.
                # No NodePort patch: preview environments stay cluster-internal.
                if [ ! -d "\$OVERLAY" ]; then
                  mkdir -p "\$OVERLAY"
                  cat > "\$OVERLAY/namespace.yaml" <<YML
apiVersion: v1
kind: Namespace
metadata: { name: infrasight-${SLUG} }
YML
                  cat > "\$OVERLAY/kustomization.yaml" <<YML
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: infrasight-${SLUG}
resources:
  - ../../base
  - namespace.yaml
images:
  - name: infrasight/backend
    newName: ${REGISTRY}/infrasight/backend
    newTag: ${TAG}
  - name: infrasight/frontend
    newName: ${REGISTRY}/infrasight/frontend
    newTag: ${TAG}
YML
                fi
              fi

              # Rewrite only the two newTag lines.
              sed -i "s|^    newTag: .*|    newTag: ${TAG}|" "\$OVERLAY/kustomization.yaml"

              if git diff --quiet && git diff --cached --quiet && [ -z "\$(git status --porcelain)" ]; then
                echo "image tag already ${TAG} - nothing to commit"
              else
                git add -A
                git commit -m "infrasight: ${BRANCH_NAME} -> ${TAG}

Built from certmonitor@${GIT_COMMIT} by Jenkins ${BUILD_NUMBER}."
                git push origin HEAD:main
              fi
            """
          }
        }
      }
    }
  }

  post {
    success { echo "Pushed ${TAG}. Argo CD will sync within ~3 minutes, or sync it now in the UI." }
    failure { echo "Build failed - the cluster is untouched, because deploys only happen via a git commit." }
  }
}
