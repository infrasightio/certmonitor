// InfraSight CI/CD -- multibranch.
//
//   build on the NODE  ->  import into containerd  ->  commit the image tag
//   into k8s-gitops  ->  Argo CD syncs it.
//
// The build does NOT run in a pod. Kaniko-in-cluster was tried and drove load
// average to 54 on this 2-vCPU box; kubelet's liveness probes timed out and
// Kubernetes restarted etcd, the apiserver, CoreDNS, Argo CD and Jenkins.
// Instead the agent SSHes to the host and runs one fixed script that builds
// with docker and loads the result straight into minikube's containerd. No
// registry push: the host docker daemon refuses plain HTTP, and fixing that
// needs a dockerd restart, which would stop the whole cluster.
//
// The key is pinned to command="/usr/local/bin/infrasight-build.sh" in
// authorized_keys, so Jenkins can run that script and nothing else.
//
// Credentials are bound with withCredentials/sshUserPrivateKey rather than the
// sshagent step: the SSH Agent plugin is not installed on this controller.
//
//   main          -> namespace `infrasight`        (overlays/prod, public)
//   any other ref -> namespace `infrasight-<slug>` (overlays/<slug>, internal)

pipeline {
  agent {
    kubernetes {
      defaultContainer 'tools'
      yaml """
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: tools
      image: alpine:3.20
      command: ["cat"]
      tty: true
      resources:
        requests: { cpu: "20m", memory: "48Mi" }
        limits:   { cpu: "300m", memory: "192Mi" }
"""
    }
  }

  options {
    timeout(time: 40, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    GITOPS_REPO = 'git@github.com:rgrishabh/k8s-gitops.git'
    BUILD_HOST  = '192.168.49.1'                 // docker bridge gateway = the EC2 host
    REGISTRY    = '192.168.49.2:32005'
    SLUG        = "${env.BRANCH_NAME.toLowerCase().replaceAll(/[^a-z0-9-]/, '-').take(30)}"
    IS_PROD     = "${env.BRANCH_NAME == 'main'}"
  }

  stages {
    stage('Prepare') {
      steps { sh 'apk add --no-cache openssh-client git >/dev/null' }
    }

    stage('Build on node') {
      steps {
        withCredentials([sshUserPrivateKey(credentialsId: 'node-build-ssh',
                                           keyFileVariable: 'SSHKEY',
                                           usernameVariable: 'SSHUSER')]) {
          script {
            // The forced command ignores whatever we ask for and reads the ref
            // from SSH_ORIGINAL_COMMAND, so this passes the ref and nothing else.
            def out = sh(returnStdout: true, script: '''
              ssh -i "$SSHKEY" -o IdentitiesOnly=yes \
                  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
                  "$SSHUSER"@"$BUILD_HOST" "$GIT_COMMIT"
            ''').trim()
            echo out
            def m = (out =~ /BUILT_SHA=([0-9a-f]+)/)
            if (!m) { error 'node build did not report BUILT_SHA' }
            env.TAG = m[0][1]
            echo "built and imported into containerd: ${env.TAG}"
          }
        }
      }
    }

    stage('Deploy: commit image tag') {
      steps {
        withCredentials([sshUserPrivateKey(credentialsId: 'k8s-gitops-ssh',
                                           keyFileVariable: 'GITKEY')]) {
          sh '''
            set -e
            export GIT_SSH_COMMAND="ssh -i $GITKEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

            if ! git ls-remote "$GITOPS_REPO" >/dev/null 2>&1; then
              echo "=================================================================="
              echo " Cannot write to k8s-gitops."
              echo " Add the jenkins deploy key to rgrishabh/k8s-gitops with"
              echo " 'Allow write access' ticked."
              echo " The images ARE built and loaded into containerd -- only the"
              echo " git commit that triggers Argo CD is blocked."
              echo "=================================================================="
              exit 1
            fi

            rm -rf /tmp/gitops
            git clone --depth 1 "$GITOPS_REPO" /tmp/gitops
            cd /tmp/gitops
            git config user.name  'jenkins'
            git config user.email 'jenkins@rgrishabh.in'

            if [ "$IS_PROD" = "true" ]; then
              OVERLAY=apps/infrasight/overlays/prod
            else
              OVERLAY="apps/infrasight/overlays/$SLUG"
              if [ ! -d "$OVERLAY" ]; then
                mkdir -p "$OVERLAY"
                printf 'apiVersion: v1\nkind: Namespace\nmetadata: { name: infrasight-%s }\n' "$SLUG" > "$OVERLAY/namespace.yaml"
                cat > "$OVERLAY/kustomization.yaml" <<YML
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: infrasight-$SLUG
resources:
  - ../../base
  - namespace.yaml
images:
  - name: infrasight/backend
    newName: $REGISTRY/infrasight/backend
    newTag: $TAG
  - name: infrasight/frontend
    newName: $REGISTRY/infrasight/frontend
    newTag: $TAG
YML
              fi
            fi

            sed -i "s|^    newTag: .*|    newTag: $TAG|" "$OVERLAY/kustomization.yaml"

            if [ -z "$(git status --porcelain)" ]; then
              echo "already at $TAG - nothing to commit"
            else
              git add -A
              git commit -m "infrasight: $BRANCH_NAME -> $TAG

Built on the node from certmonitor@$GIT_COMMIT by Jenkins $BUILD_NUMBER."
              git push origin HEAD:main
              echo "pushed - Argo CD will sync within ~3 minutes"
            fi
          '''
        }
      }
    }
  }

  post {
    success { echo "InfraSight ${env.TAG} deployed via git. Argo CD performs the rollout." }
    failure { echo 'Failed. The cluster is untouched: deploys only happen through a git commit.' }
  }
}
